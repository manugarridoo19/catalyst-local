import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { sql } from "drizzle-orm";

async function main() {
  const { db } = await import("../lib/db");

  // 1) What aliases for STRL and XYZ exist
  const r1 = await db.execute(sql`
    SELECT symbol, alias FROM ticker_aliases
    WHERE symbol IN ('STRL', 'XYZ') OR alias ILIKE '%sterling%' OR alias ILIKE '%block%'
    ORDER BY symbol, alias
  `);
  const rows1 = ((r1 as { rows?: Array<{ symbol: string; alias: string }> }).rows
    ?? (r1 as unknown as Array<{ symbol: string; alias: string }>));
  console.log("=== Aliases for STRL/XYZ + any 'sterling'/'block' ===");
  for (const r of rows1) console.log(`  ${r.symbol.padEnd(8)} ${r.alias}`);

  // 2) Recent news mislinked to STRL via "sterling" currency mentions
  const r2 = await db.execute(sql`
    SELECT n.id, n.headline, n.published_at, array_agg(nt.ticker ORDER BY nt.ticker) AS tickers
    FROM news n
    JOIN news_tickers nt ON nt.news_id = n.id
    WHERE nt.ticker IN ('STRL', 'XYZ')
      AND (n.headline ILIKE '%sterling%' OR n.headline ILIKE '%block deal%' OR n.headline ILIKE '%block trade%')
    GROUP BY n.id, n.headline, n.published_at
    ORDER BY n.published_at DESC
    LIMIT 20
  `);
  const rows2 = ((r2 as { rows?: Array<Record<string, unknown>> }).rows
    ?? (r2 as unknown as Array<Record<string, unknown>>));
  console.log(`\n=== Recent STRL/XYZ mislinks containing sterling/block ===`);
  console.log(`Total: ${rows2.length}\n`);
  for (const r of rows2) {
    const tk = Array.isArray(r.tickers) ? r.tickers.filter(Boolean).join(",") : "—";
    console.log(`  [${r.published_at}] [${tk}]\n    ${r.headline}`);
  }

  // 3) Total counts
  const r3 = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM news_tickers WHERE ticker = 'STRL') AS strl_total,
      (SELECT COUNT(*)::int FROM news_tickers nt JOIN news n ON n.id = nt.news_id
       WHERE nt.ticker = 'STRL' AND n.headline ILIKE '%sterling%') AS strl_sterling,
      (SELECT COUNT(*)::int FROM news_tickers WHERE ticker = 'XYZ') AS xyz_total,
      (SELECT COUNT(*)::int FROM news_tickers nt JOIN news n ON n.id = nt.news_id
       WHERE nt.ticker = 'XYZ' AND (n.headline ILIKE '%block deal%' OR n.headline ILIKE '%block trade%')) AS xyz_block
  `);
  const rows3 = ((r3 as { rows?: Array<Record<string, unknown>> }).rows
    ?? (r3 as unknown as Array<Record<string, unknown>>));
  console.log(`\n=== Counts ===`);
  console.log(rows3[0]);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
