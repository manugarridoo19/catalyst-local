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

  console.log("=== Inserts en los últimos 10 min — método de extracción ===");
  const methods = await db.execute(sql`
    SELECT nt.extraction_method, COUNT(DISTINCT nt.news_id)::int distinct_news, COUNT(*)::int total_links
    FROM news_tickers nt
    JOIN news n ON n.id = nt.news_id
    WHERE n.created_at > NOW() - INTERVAL '10 minutes'
    GROUP BY nt.extraction_method ORDER BY total_links DESC
  `);
  console.table(unwrap(methods));

  console.log("\n=== Sample de matches via nuevo PAREN_TICKER_REGEX (regex con 2-5 letras) ===");
  // El método 'regex' ahora incluye ambos $X y (X). Para distinguir, miro
  // los headlines que contengan paréntesis con ticker dentro.
  const paren = await db.execute(sql`
    SELECT n.id, n.headline, ARRAY(
      SELECT ticker FROM news_tickers WHERE news_id = n.id AND extraction_method = 'regex'
    ) AS tickers
    FROM news n
    WHERE n.created_at > NOW() - INTERVAL '15 minutes'
      AND n.headline ~ '\\([A-Z]+:?[A-Z]{2,5}\\)'
      AND EXISTS (SELECT 1 FROM news_tickers nt WHERE nt.news_id = n.id AND nt.extraction_method = 'regex')
    ORDER BY n.created_at DESC LIMIT 20
  `);
  for (const r of unwrap(paren)) {
    console.log(`[${r.id}] ${(r.tickers as string[]).join(",")} ← ${String(r.headline).slice(0, 100)}`);
  }

  console.log("\n=== Earnings sin ticker — comparativa antes/después ===");
  const cmp = await db.execute(sql`
    SELECT
      DATE_TRUNC('hour', n.created_at) AS hour,
      COUNT(*)::int total_earnings,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
      )::int without_ticker
    FROM news n
    WHERE n.category = 'EARNINGS' AND n.created_at > NOW() - INTERVAL '6 hours'
    GROUP BY 1 ORDER BY 1 DESC
  `);
  console.table(unwrap(cmp));

  console.log("\n=== % news con ticker, último insert vs hace 1h ===");
  const rate = await db.execute(sql`
    SELECT
      CASE
        WHEN n.created_at > NOW() - INTERVAL '15 minutes' THEN 'last 15min'
        WHEN n.created_at > NOW() - INTERVAL '1 hour' THEN 'last hour'
      END AS bucket,
      COUNT(*)::int total,
      COUNT(*) FILTER (
        WHERE EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
      )::int with_ticker,
      ROUND(100.0 * COUNT(*) FILTER (
        WHERE EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
      ) / COUNT(*), 1) AS pct
    FROM news n
    WHERE n.created_at > NOW() - INTERVAL '1 hour'
    GROUP BY 1 ORDER BY 1
  `);
  console.table(unwrap(rate));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
