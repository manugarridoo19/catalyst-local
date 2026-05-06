// One-shot: enriquece todos los tickers que no tengan logoUrl. Usa Finnhub
// /stock/profile2. Pausa breve entre llamadas para no saturar rate-limit.
//
//   pnpm tsx scripts/backfill-logos.ts

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { db } = await import("../lib/db");
  const { tickers, tickerAliases } = await import("../lib/db/schema");
  const { sql, eq } = await import("drizzle-orm");
  const { getProfile } = await import("../lib/providers/finnhub");

  const pending = await db
    .select({ symbol: tickers.symbol, name: tickers.name, hasEnriched: tickers.enrichedAt })
    .from(tickers)
    .where(sql`${tickers.logoUrl} IS NULL`);

  console.log(`[backfill] ${pending.length} tickers need a logo`);
  if (pending.length === 0) return;

  let succeeded = 0;
  let attempted = 0;
  for (const t of pending) {
    attempted++;
    const profile = await getProfile(t.symbol);
    if (profile && (profile.logo || profile.name)) {
      await db
        .update(tickers)
        .set({
          name: profile.name || t.name,
          sector: profile.finnhubIndustry || null,
          industry: profile.finnhubIndustry || null,
          marketCap: profile.marketCapitalization
            ? Math.round(profile.marketCapitalization * 1_000_000)
            : null,
          logoUrl: profile.logo || null,
          enrichedAt: new Date(),
        })
        .where(eq(tickers.symbol, t.symbol));

      if (profile.name) {
        const cleaned = profile.name
          .replace(
            /\b(Inc\.?|Corp\.?|Corporation|Co\.?|Ltd\.?|PLC|N\.?V\.?|S\.?A\.?|Group|Holdings|Holding)\b/gi,
            "",
          )
          .replace(/[,.]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (cleaned.length >= 3) {
          await db
            .insert(tickerAliases)
            .values({ alias: cleaned, symbol: t.symbol })
            .onConflictDoNothing();
        }
      }
      succeeded++;
      const tag = profile.logo ? "✓ logo" : "· no-logo";
      process.stdout.write(`  ${tag} ${t.symbol.padEnd(7)} ${profile.name?.slice(0, 40) ?? ""}\n`);
    } else {
      // Marcamos enrichedAt para no reintentar en cada cron.
      await db
        .update(tickers)
        .set({ enrichedAt: new Date() })
        .where(eq(tickers.symbol, t.symbol));
      process.stdout.write(`  ✕ skip  ${t.symbol}\n`);
    }
    // Rate limit Finnhub free: 60 req/min → 1 req cada 1.05s.
    await new Promise((r) => setTimeout(r, 1100));
    if (attempted % 25 === 0) {
      console.log(`[backfill] progress: ${attempted}/${pending.length} (${succeeded} with profile)`);
    }
  }
  console.log(`[backfill] done: ${succeeded}/${pending.length} enriched`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
