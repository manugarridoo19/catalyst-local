import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { sql } from "drizzle-orm";

async function main() {
  const { db } = await import("../lib/db");

  // 1) Search for "Vista" or "raises" headlines associated with JPM
  const r1 = await db.execute(sql`
    SELECT n.id, n.headline, n.published_at, ns.impact, ns.sentiment
    FROM news n
    JOIN news_tickers nt ON nt.news_id = n.id
    LEFT JOIN news_scores ns ON ns.news_id = n.id
    WHERE nt.ticker = 'JPM'
      AND (n.headline ILIKE '%raises%' OR n.headline ILIKE '%target%' OR n.headline ILIKE '%vista%')
    ORDER BY n.published_at DESC
    LIMIT 20
  `);
  const rows1 = (r1 as { rows?: Array<Record<string, unknown>> }).rows ?? (r1 as unknown as Array<Record<string, unknown>>);
  console.log(`\n=== JPM news containing "raises"/"target"/"vista" (any case) ===`);
  console.log(`Found ${rows1.length}\n`);
  for (const row of rows1) {
    console.log(`[${row.published_at}] impact=${row.impact ?? "—"} sent=${row.sentiment ?? "—"}`);
    console.log(`  ${row.headline}`);
  }

  // 2) ALL recent JPM-linked news to understand what's there
  const r2 = await db.execute(sql`
    SELECT n.headline, n.published_at
    FROM news n
    JOIN news_tickers nt ON nt.news_id = n.id
    WHERE nt.ticker = 'JPM'
    ORDER BY n.published_at DESC
    LIMIT 15
  `);
  const rows2 = (r2 as { rows?: Array<Record<string, unknown>> }).rows ?? (r2 as unknown as Array<Record<string, unknown>>);
  console.log(`\n=== Latest 15 JPM-linked news (any headline) ===`);
  for (const row of rows2) {
    console.log(`[${row.published_at}] ${row.headline}`);
  }

  // 3) Headlines that START with bank name + action verb (regardless of linked ticker)
  const r3 = await db.execute(sql`
    SELECT n.headline, array_agg(nt.ticker ORDER BY nt.ticker) AS tickers, ns.impact, ns.sentiment, n.published_at
    FROM news n
    LEFT JOIN news_tickers nt ON nt.news_id = n.id
    LEFT JOIN news_scores ns ON ns.news_id = n.id
    WHERE (
      n.headline ILIKE 'JPMorgan %'
      OR n.headline ILIKE 'JP Morgan %'
      OR n.headline ILIKE 'Morgan Stanley %'
      OR n.headline ILIKE 'Goldman Sachs %'
      OR n.headline ILIKE 'Goldman %'
      OR n.headline ILIKE 'Bank of America %'
      OR n.headline ILIKE 'BofA %'
      OR n.headline ILIKE 'Wells Fargo %'
      OR n.headline ILIKE 'Citi %'
      OR n.headline ILIKE 'Citigroup %'
      OR n.headline ILIKE 'Barclays %'
      OR n.headline ILIKE 'UBS %'
      OR n.headline ILIKE 'Deutsche Bank %'
      OR n.headline ILIKE 'Stifel %'
      OR n.headline ILIKE 'Piper Sandler %'
      OR n.headline ILIKE 'Jefferies %'
      OR n.headline ILIKE 'Truist %'
      OR n.headline ILIKE 'Wedbush %'
      OR n.headline ILIKE 'Mizuho %'
      OR n.headline ILIKE 'Raymond James %'
      OR n.headline ILIKE 'Oppenheimer %'
      OR n.headline ILIKE 'KBW %'
      OR n.headline ILIKE 'BTIG %'
      OR n.headline ILIKE 'Cantor %'
      OR n.headline ILIKE 'Needham %'
      OR n.headline ILIKE 'Baird %'
      OR n.headline ILIKE 'Evercore %'
      OR n.headline ILIKE 'RBC %'
      OR n.headline ILIKE 'BMO %'
      OR n.headline ILIKE 'HSBC %'
    )
    AND (
      n.headline ILIKE '% raises %'
      OR n.headline ILIKE '% cuts %'
      OR n.headline ILIKE '% maintains %'
      OR n.headline ILIKE '% reiterates %'
      OR n.headline ILIKE '% upgrades %'
      OR n.headline ILIKE '% downgrades %'
      OR n.headline ILIKE '% initiates %'
      OR n.headline ILIKE '% lifts %'
      OR n.headline ILIKE '% lowers %'
      OR n.headline ILIKE '% reaffirms %'
      OR n.headline ILIKE '% trims %'
      OR n.headline ILIKE '% boosts %'
      OR n.headline ILIKE '% hikes %'
    )
    GROUP BY n.id, n.headline, n.published_at, ns.impact, ns.sentiment
    ORDER BY n.published_at DESC
    LIMIT 40
  `);
  const rows3 = (r3 as { rows?: Array<Record<string, unknown>> }).rows ?? (r3 as unknown as Array<Record<string, unknown>>);
  console.log(`\n=== Headlines starting with bank + action verb (last 40) ===`);
  console.log(`Total: ${rows3.length}\n`);
  for (const row of rows3) {
    const tickers = Array.isArray(row.tickers) ? row.tickers.filter(Boolean).join(",") : "—";
    console.log(`[${row.published_at}] tickers=[${tickers}] impact=${row.impact ?? "—"} sent=${row.sentiment ?? "—"}`);
    console.log(`  ${row.headline}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
