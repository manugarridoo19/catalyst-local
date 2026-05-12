import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { sql } from "drizzle-orm";

async function main() {
  const { db } = await import("../lib/db");

  // 1) Vista Oil case
  const r1 = await db.execute(sql`
    SELECT n.id, n.headline, array_agg(nt.ticker ORDER BY nt.ticker) AS tickers
    FROM news n
    LEFT JOIN news_tickers nt ON nt.news_id = n.id
    WHERE n.headline ILIKE '%Vista Oil%'
    GROUP BY n.id, n.headline
    ORDER BY n.published_at DESC
    LIMIT 5
  `);
  const rows1 = ((r1 as { rows?: Array<Record<string, unknown>> }).rows
    ?? (r1 as unknown as Array<Record<string, unknown>>));
  console.log("=== Vista Oil headlines ===");
  for (const r of rows1) {
    const tk = Array.isArray(r.tickers) ? r.tickers.filter(Boolean).join(",") : "—";
    console.log(`  news#${r.id} [${tk}]\n    ${r.headline}`);
  }

  // 2) Verify named misses now have tickers
  const namedMisses = ["RDNT", "CPT", "EVH", "ESS", "HMC", "LUMN", "GPK", "PRMW", "VIST", "MCD", "MOH", "ARTV", "NBIS", "EOSE", "GPN", "FTRE"];
  console.log("\n=== Named-miss tickers — news count linked after backfill ===");
  for (const sym of namedMisses) {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM news_tickers
      WHERE ticker = ${sym}
    `);
    const rows = ((r as { rows?: Array<{ n: number }> }).rows ?? (r as unknown as Array<{ n: number }>));
    const n = rows[0]?.n ?? 0;
    console.log(`  ${sym.padEnd(6)} ${n.toString().padStart(4)} links`);
  }

  // 3) Specific cases referenced in G — verify post-fix attribution
  console.log("\n=== Sample analyst-action headlines (post-G + post-B) ===");
  const r3 = await db.execute(sql`
    SELECT n.id, n.headline, array_agg(nt.ticker ORDER BY nt.ticker) AS tickers, ns.impact, ns.sentiment
    FROM news n
    LEFT JOIN news_tickers nt ON nt.news_id = n.id
    LEFT JOIN news_scores ns ON ns.news_id = n.id
    WHERE n.headline IN (
      'JPMorgan raises Vista Oil stock price target to $93 on acquisition',
      'JPMorgan Cuts McDonald’s Price Target to $305: Is the Same-Store-Sales Story Stalling?',
      'Cantor Fitzgerald Boosts Artiva Biotherapeutics (NASDAQ:ARTV) Price Target to $40.00',
      'Bank of America Raises Nebius Group (NASDAQ:NBIS) Price Target to $205.00',
      'JPMorgan Cuts Eos Energy (EOSE) Target – Here’s Why'
    )
    GROUP BY n.id, n.headline, ns.impact, ns.sentiment
    ORDER BY n.published_at DESC
  `);
  const rows3 = ((r3 as { rows?: Array<Record<string, unknown>> }).rows
    ?? (r3 as unknown as Array<Record<string, unknown>>));
  for (const r of rows3) {
    const tk = Array.isArray(r.tickers) ? r.tickers.filter(Boolean).join(",") : "—";
    console.log(`  news#${r.id} [${tk}] impact=${r.impact ?? "—"} sent=${r.sentiment ?? "—"}`);
    console.log(`    ${r.headline}`);
  }

  // 4) Global coverage
  const r4 = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE id IN (SELECT news_id FROM news_tickers))::int AS tagged
    FROM news
  `);
  const rows4 = ((r4 as { rows?: Array<{ total: number; tagged: number }> }).rows
    ?? (r4 as unknown as Array<{ total: number; tagged: number }>));
  const { total, tagged } = rows4[0];
  console.log(`\n=== Coverage ===\n  ${tagged}/${total} = ${(100 * tagged / total).toFixed(1)}%`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
