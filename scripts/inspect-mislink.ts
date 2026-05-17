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

  // Buscar news que mencionen DELL y estén linkeadas a PLTR.
  const r = await db.execute(sql`
    SELECT n.id, n.headline, n.body, n.source,
      ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id ORDER BY ticker) AS tickers
    FROM news n
    JOIN news_tickers nt ON nt.news_id = n.id
    WHERE nt.ticker = 'PLTR'
      AND (n.headline ILIKE '%dell%' OR n.body ILIKE '%dell%')
    ORDER BY n.published_at DESC
    LIMIT 10
  `);
  console.log("\nDELL-mentioning news linked to PLTR:");
  for (const row of unwrap(r)) {
    console.log(`[${row.id}] ${row.headline}`);
    console.log(`  tickers: ${JSON.stringify(row.tickers)}`);
    console.log(`  body: ${String(row.body ?? "").slice(0, 200)}`);
    console.log("");
  }

  // Aliases que tienen PLTR
  const al = await db.execute(sql`
    SELECT alias FROM ticker_aliases WHERE symbol = 'PLTR'
  `);
  console.log("PLTR aliases:");
  console.table(unwrap(al));

  // Aliases que tienen DELL
  const dl = await db.execute(sql`
    SELECT alias FROM ticker_aliases WHERE symbol = 'DELL'
  `);
  console.log("DELL aliases:");
  console.table(unwrap(dl));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
