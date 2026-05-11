import { config } from "dotenv";
config({ path: ".env.local" });

type Row = Record<string, unknown>;
const unwrap = (r: unknown): Row[] => {
  const w = r as { rows?: Row[] };
  return (w.rows ?? (r as Row[])) as Row[];
};

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");

  console.log("=== Links creados en los últimos 5 min (backfill output) ===");
  const r = await db.execute(sql`
    SELECT nt.extraction_method, COUNT(*)::int n
    FROM news_tickers nt
    JOIN news n ON n.id = nt.news_id
    WHERE n.created_at < NOW() - INTERVAL '20 minutes'  -- skip newly-inserted
    GROUP BY nt.extraction_method
  `);
  console.table(unwrap(r));

  console.log("\n=== Sample recovered news con ticker via PAREN regex ===");
  const paren = await db.execute(sql`
    SELECT DISTINCT ON (n.id) n.id, n.headline, n.category,
      (SELECT STRING_AGG(ticker, ',') FROM news_tickers WHERE news_id = n.id) AS tickers
    FROM news n
    JOIN news_tickers nt ON nt.news_id = n.id
    WHERE nt.extraction_method = 'regex'
      AND n.headline ~ '\\([A-Z]+:?[A-Z]{2,5}\\)'
    ORDER BY n.id DESC LIMIT 20
  `);
  for (const row of unwrap(paren)) {
    console.log(`[${row.id}] ${row.tickers} ← ${String(row.headline).slice(0, 100)}`);
  }

  console.log("\n=== Earnings sin ticker AHORA (después del backfill) ===");
  const stillUnlinked = await db.execute(sql`
    SELECT COUNT(*)::int n FROM news n
    WHERE n.category = 'EARNINGS'
      AND NOT EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
  `);
  console.log("Total earnings sin ticker:", ((stillUnlinked as { rows?: Row[] }).rows ?? stillUnlinked)[0]);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
