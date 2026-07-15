import { config } from "dotenv";
config({ path: ".env.local" });

// Purga aliases catastróficos que linkean noticias incorrectamente.
// "Performance" → PFGC, "Canadian" → CNI, etc.
//
// Estrategia:
//   1. Lista explícita de aliases problemáticos confirmados en audit
//   2. DELETE de ticker_aliases (idempotente)
//   3. DELETE de news_tickers donde extraction_method='dict' AND el ticker
//      asociado solo tiene aliases que están en la blacklist (limpia
//      enlaces históricos malos sin tocar tickers legit que tengan otros
//      aliases buenos)
//
// El extractor también lleva esta lista en ALIAS_DENYLIST → si vuelve a
// auto-generarse el alias, lo rechazará al matching time.

const PURGE_ALIASES: Array<{ alias: string; symbol?: string; reason: string }> = [
  { alias: "Performance", symbol: "PFGC", reason: "matches 'performance review' etc." },
  { alias: "Canadian",    symbol: "CNI",  reason: "matches 'Canadian Natural Resources' (CNQ) etc." },
  { alias: "Bullish",     symbol: "BLSH", reason: "matches 'investors bullish', 'remain bullish'" },
  // Goldman se queda — es legit short name, multi-linkage es OK.
  // Arm/Meta/Snap se quedan — son brand names legítimos con case-sensitive
  // match (length<=4 → la regex usa flags="" en extractor.ts:93).
];

async function main() {
  const { sql, and, eq } = await import("drizzle-orm");
  const { db } = await import("../lib/db");
  const { tickerAliases, newsTickers } = await import("../lib/db/schema");

  for (const { alias, symbol, reason } of PURGE_ALIASES) {
    console.log(`\n→ ${alias} ${symbol ? `(${symbol})` : ""} — ${reason}`);

    // 1) Cuenta cuántos enlaces existen antes de borrar
    if (symbol) {
      const r = await db.execute(sql`
        SELECT COUNT(*)::int n FROM news_tickers
        WHERE ticker = ${symbol} AND extraction_method = 'dict'
      `);
      const row = (r as { rows?: { n: number }[] }).rows ?? (r as unknown as { n: number }[]);
      console.log(`  ${(row[0]?.n ?? 0)} news_tickers via dict para ${symbol}`);
    }

    // 2) DELETE alias
    if (symbol) {
      await db
        .delete(tickerAliases)
        .where(and(eq(tickerAliases.alias, alias), eq(tickerAliases.symbol, symbol)));
    } else {
      await db.delete(tickerAliases).where(eq(tickerAliases.alias, alias));
    }
    console.log(`  ✓ alias deleted`);

    // 3) Si el ticker NO tiene otros aliases buenos (todos los suyos eran
    //    este malo), purgamos también news_tickers dict-only para él.
    //    Si tiene otros aliases, dejamos news_tickers porque pueden ser
    //    matches por esos otros.
    if (symbol) {
      const remaining = await db
        .select({ alias: tickerAliases.alias })
        .from(tickerAliases)
        .where(eq(tickerAliases.symbol, symbol));
      console.log(`  remaining aliases for ${symbol}: ${remaining.map((r) => r.alias).join(", ") || "(none)"}`);
      if (remaining.length === 0) {
        // ESTRATEGIA AGRESIVA: si no quedan aliases, purga TODOS los
        // news_tickers via dict (los via api/regex se mantienen, son
        // confianza alta del provider).
        const purged = await db
          .delete(newsTickers)
          .where(and(eq(newsTickers.ticker, symbol), eq(newsTickers.extractionMethod, "dict")))
          .returning({ id: newsTickers.newsId });
        console.log(`  ✓ purged ${purged.length} dict-only news_tickers for ${symbol}`);
      } else {
        console.log(`  (kept news_tickers — symbol has other aliases)`);
      }
    }
  }

  // 4) Verificación final
  console.log("\n=== Final state ===");
  for (const { symbol } of PURGE_ALIASES) {
    if (!symbol) continue;
    const aCount = await db.execute(sql`SELECT COUNT(*)::int n FROM ticker_aliases WHERE symbol = ${symbol}`);
    const tCount = await db.execute(sql`SELECT COUNT(*)::int n FROM news_tickers WHERE ticker = ${symbol}`);
    const ar = ((aCount as { rows?: { n: number }[] }).rows ?? aCount)[0];
    const tr = ((tCount as { rows?: { n: number }[] }).rows ?? tCount)[0];
    console.log(`  ${symbol}: aliases=${ar.n}, news_tickers=${tr.n}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
