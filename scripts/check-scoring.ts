import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const q = (s: ReturnType<typeof sql>) =>
    db.execute(s).then((r) => {
      const rows = unwrapRows<Record<string, unknown>>(r);
      return rows[0] ?? {};
    });

  const totals = await q(sql`
    SELECT
      count(*)::int AS news_total,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM news_scores WHERE news_id = news.id))::int AS news_scored,
      count(*) FILTER (
        WHERE published_at >= now() - interval '24 hours'
      )::int AS news_last_24h,
      count(*) FILTER (
        WHERE published_at >= now() - interval '24 hours'
          AND EXISTS (SELECT 1 FROM news_scores WHERE news_id = news.id)
      )::int AS scored_last_24h,
      count(*) FILTER (
        WHERE published_at >= now() - interval '1 hour'
      )::int AS news_last_1h,
      count(*) FILTER (
        WHERE published_at >= now() - interval '1 hour'
          AND EXISTS (SELECT 1 FROM news_scores WHERE news_id = news.id)
      )::int AS scored_last_1h
    FROM news
  `);

  const newest = await db.execute(sql`
    SELECT n.id, n.headline, n.published_at, n.source,
      EXISTS (SELECT 1 FROM news_scores s WHERE s.news_id = n.id) AS has_score
    FROM news n
    WHERE n.published_at >= now() - interval '2 hours'
    ORDER BY n.published_at DESC
    LIMIT 10
  `);

  const scoreModel = await q(sql`
    SELECT model, count(*)::int AS c
    FROM news_scores
    WHERE scored_at >= now() - interval '24 hours'
    GROUP BY model
  `);

  console.log("=== news vs scoring ===");
  console.log(totals);
  console.log("\n=== last 10 news within 2h, scored? ===");
  for (const r of unwrapRows<{
    id: number;
    headline: string;
    published_at: Date;
    source: string;
    has_score: boolean;
  }>(newest)) {
    console.log(
      `${r.has_score ? "[scored]" : "[----- ]"} ${new Date(r.published_at).toISOString().slice(11, 16)}  ${r.source.padEnd(20)}  ${r.headline.slice(0, 60)}`,
    );
  }
  console.log("\n=== models used in last 24h ===");
  console.log(scoreModel);

  // OpenRouter key pool live status (which keys are available right now).
  const { getKeyPoolStatus } = await import("../lib/providers/openrouter");
  const pool = getKeyPoolStatus();
  console.log(`\n=== OpenRouter key pool (${pool.available}/${pool.total} live) ===`);
  for (const k of pool.pool) {
    console.log(
      `  ${k.label}  ${k.available ? "AVAILABLE" : `cooled → ${k.cooldownUntil ?? "?"}`}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
