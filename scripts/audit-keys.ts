import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

type Row = Record<string, unknown>;
const unwrap = (r: unknown): Row[] => {
  const w = r as { rows?: Row[] };
  return (w.rows ?? (r as Row[])) as Row[];
};

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");

  // 1) news_tickers: PK (news_id, ticker) → no dupes esperadas
  const a = await db.execute(sql`
    SELECT news_id, ticker, COUNT(*)::int n
    FROM news_tickers GROUP BY news_id, ticker HAVING COUNT(*) > 1 LIMIT 5
  `);
  console.log("news_tickers dupes:", unwrap(a));

  // 2) Aliases con MISMO texto apuntando a SÍMBOLOS distintos — ej. "Apple"
  //    → AAPL + APLE. Si haystack matchea el alias, ambos tickers entran.
  //    El extractor solo evita dupes con el MISMO símbolo, pero diferentes
  //    símbolos via mismo alias colarían dupes de "Apple" → ambos.
  const b = await db.execute(sql`
    SELECT alias, COUNT(*)::int n, ARRAY_AGG(symbol ORDER BY symbol) syms
    FROM ticker_aliases GROUP BY alias HAVING COUNT(*) > 1 LIMIT 30
  `);
  console.log("\naliases shared by multiple symbols:");
  for (const r of unwrap(b)) {
    console.log(`  "${r.alias}" → ${(r.syms as string[]).join(", ")}`);
  }

  // 3) Watchlist dupes por (userSession, symbol) — unique idx esperado
  const c = await db.execute(sql`
    SELECT user_session, symbol, COUNT(*)::int n
    FROM watchlist GROUP BY user_session, symbol HAVING COUNT(*) > 1 LIMIT 5
  `);
  console.log("\nwatchlist dupes:", unwrap(c));

  // 4) Tickers con MISMO nombre (riesgo de duplicar logo cards)
  const d = await db.execute(sql`
    SELECT LOWER(name) lo, COUNT(*)::int n, ARRAY_AGG(symbol ORDER BY symbol) syms
    FROM tickers WHERE name IS NOT NULL GROUP BY LOWER(name) HAVING COUNT(*) > 1 LIMIT 20
  `);
  console.log("\ntickers with shared name:");
  for (const r of unwrap(d)) {
    console.log(`  "${r.lo}" → ${(r.syms as string[]).join(", ")}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
