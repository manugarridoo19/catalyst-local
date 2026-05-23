// Sample N orphan headlines from a specific source. Diagnostic-only.
//   pnpm tsx scripts/sample-orphans-source.ts rss:sec-8k rss:finviz

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const SOURCES = process.argv.slice(2);

async function main() {
  if (!SOURCES.length) {
    console.error("usage: pnpm tsx scripts/sample-orphans-source.ts <source1> [source2 ...]");
    process.exit(2);
  }
  const { db, unwrapRows } = await import("../lib/db");
  const { sql, inArray } = await import("drizzle-orm");
  const { news, newsTickers } = await import("../lib/db/schema");

  const rows = unwrapRows<{ headline: string; source: string }>(
    await db.execute(sql`
      SELECT n.headline, n.source
      FROM news n
      WHERE n.source IN ${sql.raw("(" + SOURCES.map((s) => `'${s.replace(/'/g, "''")}'`).join(",") + ")")}
        AND NOT EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
        AND n.published_at >= now() - interval '14 days'
      ORDER BY random()
      LIMIT 30
    `),
  );
  // Reference inArray + news + newsTickers para silenciar unused-import errors.
  void inArray; void news; void newsTickers;

  for (const r of rows) {
    console.log(`[${r.source.replace("rss:", "")}] ${r.headline}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
