import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { sql } from "drizzle-orm";

async function main() {
  const { db, unwrapRows } = await import("../lib/db");

  // 1) Distribución global de categorías (solo news con ticker, recientes)
  const r1 = await db.execute(sql`
    SELECT category, COUNT(*)::int AS n
    FROM news n
    WHERE EXISTS (SELECT 1 FROM news_tickers nt WHERE nt.news_id = n.id)
      AND published_at > NOW() - INTERVAL '7 days'
    GROUP BY category
    ORDER BY n DESC
  `);
  console.log("=== Category distribution (news with ticker, last 7 days) ===");
  console.table(unwrapRows<{ category: string | null; n: number }>(r1));

  // 2) Top sources de OTHER — confirma si Yahoo/finnhub:company dominan
  const r2 = await db.execute(sql`
    SELECT source, COUNT(*)::int AS n
    FROM news n
    WHERE EXISTS (SELECT 1 FROM news_tickers nt WHERE nt.news_id = n.id)
      AND published_at > NOW() - INTERVAL '7 days'
      AND (category = 'OTHER' OR category IS NULL)
    GROUP BY source
    ORDER BY n DESC
    LIMIT 25
  `);
  console.log("\n=== Top sources of OTHER/NULL category items (7d, with ticker) ===");
  console.table(unwrapRows<{ source: string; n: number }>(r2));

  // 3) Sample de OTHER headlines para detectar patrones que el categorizer
  //    debería capturar pero se le escapan
  const r3 = await db.execute(sql`
    SELECT n.headline, n.source
    FROM news n
    WHERE EXISTS (SELECT 1 FROM news_tickers nt WHERE nt.news_id = n.id)
      AND (n.category = 'OTHER' OR n.category IS NULL)
      AND n.published_at > NOW() - INTERVAL '2 days'
    ORDER BY RANDOM()
    LIMIT 30
  `);
  console.log("\n=== Sample OTHER headlines (random, 2 days) ===");
  for (const r of unwrapRows<{ headline: string; source: string }>(r3)) {
    console.log(`  [${r.source.slice(0, 30).padEnd(30)}] ${r.headline.slice(0, 100)}`);
  }

  // 4) Distribución por source tier de items con ticker
  const r4 = await db.execute(sql`
    WITH tiered AS (
      SELECT n.id,
        CASE
          WHEN n.source IN ('rss:marketbeat','rss:marketbeat-ratings','rss:seeking-alpha',
                            'rss:investing-com','rss:tipranks','rss:zacks') THEN 'premium'
          WHEN n.source IN ('rss:yahoo-finance','rss:kiplinger','rss:forbes-markets',
                            'rss:247wallst','rss:finviz','rss:etftrends') THEN 'noise'
          WHEN n.source LIKE 'gnews:%' THEN 'gnews'
          WHEN n.source LIKE 'finnhub:%' THEN 'finnhub'
          ELSE 'standard'
        END AS tier
      FROM news n
      WHERE EXISTS (SELECT 1 FROM news_tickers nt WHERE nt.news_id = n.id)
        AND n.published_at > NOW() - INTERVAL '7 days'
    )
    SELECT tier, COUNT(*)::int AS n FROM tiered GROUP BY tier ORDER BY n DESC
  `);
  console.log("\n=== Source tier distribution (with ticker, 7 days) ===");
  console.table(unwrapRows<{ tier: string; n: number }>(r4));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
