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

  console.log("\n=== A) Data volumes & retention ===");
  const sizes = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM news) AS news_total,
      (SELECT COUNT(*)::int FROM news WHERE published_at > NOW() - INTERVAL '24 hours') AS news_24h,
      (SELECT COUNT(*)::int FROM news WHERE published_at > NOW() - INTERVAL '7 days') AS news_7d,
      (SELECT COUNT(*)::int FROM news_tickers) AS news_tickers,
      (SELECT COUNT(*)::int FROM news_scores) AS scores,
      (SELECT COUNT(*)::int FROM tickers) AS tickers,
      (SELECT COUNT(*)::int FROM ticker_aliases) AS aliases,
      (SELECT pg_size_pretty(pg_database_size(current_database()))) AS db_size
  `);
  console.table(unwrap(sizes));

  console.log("\n=== B) Coverage (% news scored, % news with tickers) ===");
  const cov = await db.execute(sql`
    SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM news_tickers nt WHERE nt.news_id = n.id))::int with_tickers,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM news_scores ns WHERE ns.news_id = n.id))::int with_score,
      COUNT(*) FILTER (WHERE n.category IS NOT NULL)::int with_category,
      COUNT(*) FILTER (WHERE n.body IS NOT NULL AND LENGTH(n.body) > 50)::int with_body
    FROM news n
  `);
  console.table(unwrap(cov));

  console.log("\n=== C) Scoring distribution by model & impact ===");
  const dist = await db.execute(sql`
    SELECT model, impact, COUNT(*)::int n
    FROM news_scores
    GROUP BY model, impact ORDER BY model, impact
  `);
  console.table(unwrap(dist));

  console.log("\n=== D) % i*s0 (neutro perezoso) per model ===");
  const neutral = await db.execute(sql`
    SELECT model,
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE sentiment = 0)::int sent0,
      ROUND(100.0 * COUNT(*) FILTER (WHERE sentiment = 0) / COUNT(*), 1) AS pct_sent0
    FROM news_scores
    GROUP BY model ORDER BY total DESC
  `);
  console.table(unwrap(neutral));

  console.log("\n=== E) Tickers without enrichment (need name/logo) ===");
  const enrich = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE name IS NULL)::int no_name,
      COUNT(*) FILTER (WHERE logo_url IS NULL)::int no_logo,
      COUNT(*) FILTER (WHERE enriched_at IS NULL)::int never_tried,
      COUNT(*)::int total
    FROM tickers
  `);
  console.table(unwrap(enrich));

  console.log("\n=== F) Top sources last 24h (variety check) ===");
  const sources = await db.execute(sql`
    SELECT source, COUNT(*)::int n
    FROM news WHERE published_at > NOW() - INTERVAL '24 hours'
    GROUP BY source ORDER BY n DESC LIMIT 15
  `);
  console.table(unwrap(sources));

  console.log("\n=== G) News with NO ticker (potential extractor miss) ===");
  const orphans = await db.execute(sql`
    SELECT category, COUNT(*)::int n
    FROM news n
    WHERE NOT EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
      AND n.published_at > NOW() - INTERVAL '24 hours'
    GROUP BY category ORDER BY n DESC
  `);
  console.table(unwrap(orphans));

  console.log("\n=== H) Index existence check (key perf paths) ===");
  const idx = await db.execute(sql`
    SELECT tablename, indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('news','news_tickers','news_scores','tickers','ticker_aliases','watchlist')
    ORDER BY tablename, indexname
  `);
  console.table(unwrap(idx));

  console.log("\n=== I) Suspicious aliases (could mislink) ===");
  const susp = await db.execute(sql`
    SELECT alias, symbol
    FROM ticker_aliases
    WHERE LENGTH(alias) < 5
      AND alias = INITCAP(alias)
      AND alias NOT IN (
        SELECT UPPER(alias) FROM ticker_aliases
      )
    ORDER BY LENGTH(alias), alias
    LIMIT 30
  `);
  console.table(unwrap(susp));

  console.log("\n=== J) Recently mislinked candidates (news with 1 ticker via dict only) ===");
  const dictOnly = await db.execute(sql`
    SELECT n.id, n.headline,
      (SELECT ticker FROM news_tickers WHERE news_id = n.id LIMIT 1) AS primary_ticker,
      (SELECT extraction_method FROM news_tickers WHERE news_id = n.id LIMIT 1) AS method
    FROM news n
    WHERE n.published_at > NOW() - INTERVAL '6 hours'
      AND (SELECT COUNT(*) FROM news_tickers WHERE news_id = n.id) = 1
      AND EXISTS (
        SELECT 1 FROM news_tickers nt
        WHERE nt.news_id = n.id AND nt.extraction_method = 'dict'
      )
    ORDER BY n.published_at DESC LIMIT 15
  `);
  console.table(unwrap(dictOnly));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
