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

  const dist = await db.execute(sql`
    SELECT impact, sentiment, COUNT(*)::int as n
    FROM news_scores
    GROUP BY impact, sentiment
    ORDER BY impact, sentiment
  `);
  console.log("\nScore distribution (impact, sentiment, count):");
  console.table(unwrap(dist));

  const suspect = await db.execute(sql`
    SELECT n.id, n.headline, n.source, s.impact, s.sentiment, s.rationale
    FROM news n
    JOIN news_scores s ON s.news_id = n.id
    WHERE (
      n.headline ILIKE '%beat%' OR n.headline ILIKE '%raised%' OR
      n.headline ILIKE '%surge%' OR n.headline ILIKE '%soar%' OR
      n.headline ILIKE '%rally%' OR n.headline ILIKE '%jump%' OR
      n.headline ILIKE '%record%' OR n.headline ILIKE '%upgrade%'
    )
    AND s.sentiment <= 1
    ORDER BY n.created_at DESC
    LIMIT 25
  `);
  console.log("\nPositive-sounding headlines with sentiment <= 1:");
  for (const r of unwrap(suspect)) {
    console.log(`[i${r.impact} s${r.sentiment}] ${String(r.headline).slice(0, 110)}`);
    console.log(`   rationale: ${r.rationale}`);
  }

  const suspect2 = await db.execute(sql`
    SELECT n.id, n.headline, s.impact, s.sentiment, s.rationale
    FROM news n
    JOIN news_scores s ON s.news_id = n.id
    WHERE (
      n.headline ILIKE '%miss%' OR n.headline ILIKE '%plunge%' OR
      n.headline ILIKE '%tumble%' OR n.headline ILIKE '%crash%' OR
      n.headline ILIKE '%fraud%' OR n.headline ILIKE '%halt%' OR
      n.headline ILIKE '%downgrade%' OR n.headline ILIKE '%cut%'
    )
    AND s.sentiment >= -1
    ORDER BY n.created_at DESC
    LIMIT 15
  `);
  console.log("\nNegative-sounding headlines with sentiment >= -1:");
  for (const r of unwrap(suspect2)) {
    console.log(`[i${r.impact} s${r.sentiment}] ${String(r.headline).slice(0, 110)}`);
    console.log(`   rationale: ${r.rationale}`);
  }

  const earn = await db.execute(sql`
    SELECT n.id, n.headline, n.body, s.impact, s.sentiment, s.rationale, s.model
    FROM news n
    JOIN news_scores s ON s.news_id = n.id
    WHERE n.category = 'EARNINGS'
    ORDER BY n.created_at DESC
    LIMIT 20
  `);
  console.log("\nLatest 20 EARNINGS-scored:");
  for (const r of unwrap(earn)) {
    console.log(`[i${r.impact} s${r.sentiment}] ${String(r.headline).slice(0, 110)}`);
    console.log(`   body:      ${String(r.body ?? "").slice(0, 160).replace(/\s+/g, " ")}`);
    console.log(`   rationale: ${r.rationale}   (${r.model})`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
