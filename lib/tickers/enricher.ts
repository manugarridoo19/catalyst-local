import { db } from "@/lib/db";
import { tickers, tickerAliases } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { getProfile } from "@/lib/providers/finnhub";

// Tickers nuevos llegan sin metadata. En cada cron procesamos hasta N de
// los más antiguos sin enriquecer (FIFO) — limitado para no agotar el
// rate-limit de Finnhub free (60 req/min). El cron también gasta llamadas
// en el fetch de noticias, así que dejamos margen.
const ENRICH_BATCH = 40;

export async function enrichPendingTickers(limit = ENRICH_BATCH) {
  // Re-enriquecer si nunca se hizo, o si falta logo (column nuevo).
  const pending = await db
    .select({ symbol: tickers.symbol })
    .from(tickers)
    .where(
      sql`${tickers.enrichedAt} IS NULL OR ${tickers.logoUrl} IS NULL`,
    )
    .limit(limit);

  let done = 0;
  for (const { symbol } of pending) {
    const profile = await getProfile(symbol);
    const now = new Date();
    if (profile && profile.name) {
      await db
        .update(tickers)
        .set({
          name: profile.name,
          sector: profile.finnhubIndustry || null,
          industry: profile.finnhubIndustry || null,
          marketCap: profile.marketCapitalization
            ? Math.round(profile.marketCapitalization * 1_000_000)
            : null,
          logoUrl: profile.logo || null,
          enrichedAt: now,
        })
        .where(eq(tickers.symbol, symbol));

      // Crear alias automático para futuras detecciones por nombre.
      const aliasCandidates = uniqueAliases(profile.name);
      for (const alias of aliasCandidates) {
        await db
          .insert(tickerAliases)
          .values({ alias, symbol })
          .onConflictDoNothing();
      }
      done++;
    } else {
      // Marcamos como enriquecido aunque sea sin datos para no reintentar.
      await db
        .update(tickers)
        .set({ enrichedAt: now })
        .where(eq(tickers.symbol, symbol));
    }
  }
  return { processed: pending.length, succeeded: done };
}

function uniqueAliases(name: string): string[] {
  const aliases = new Set<string>();
  const cleaned = name
    .replace(/\b(Inc\.?|Corp\.?|Corporation|Co\.?|Ltd\.?|PLC|N\.?V\.?|S\.?A\.?|Group|Holdings|Holding)\b/gi, "")
    .replace(/[,.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 3) aliases.add(cleaned);
  if (name.trim().length >= 3 && name.trim() !== cleaned) {
    aliases.add(name.trim());
  }
  return Array.from(aliases);
}
