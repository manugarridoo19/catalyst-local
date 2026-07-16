import { config } from "dotenv";
config({ path: ".env.local" });

// Diagnóstico de calidad del feed: fechas futuras, mislinks por fuente,
// cadencia de inserción. Uso: pnpm exec tsx scripts/diagnose-feed.ts
async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const rows = <T,>(s: ReturnType<typeof sql>) =>
    db.execute(s).then((r) => unwrapRows<T>(r));

  console.log("=== 1. Noticias con published_at EN EL FUTURO, por fuente ===");
  console.log(
    await rows(sql`
      SELECT source, count(*)::int AS n,
        round(avg(EXTRACT(EPOCH FROM (published_at - now())) / 60))::int AS avg_min_future,
        max(published_at) AS max_pub
      FROM news
      WHERE published_at > now() + interval '2 minutes'
      GROUP BY source ORDER BY n DESC LIMIT 20
    `),
  );

  console.log("\n=== 2. Muestras futuras (top 10) ===");
  for (const r of await rows<{
    source: string;
    published_at: Date;
    created_at: Date;
    headline: string;
  }>(sql`
    SELECT source, published_at, created_at, headline
    FROM news WHERE published_at > now() + interval '2 minutes'
    ORDER BY published_at DESC LIMIT 10
  `)) {
    console.log(
      `pub=${new Date(r.published_at).toISOString()} ins=${new Date(r.created_at).toISOString()} [${r.source}] ${r.headline.slice(0, 70)}`,
    );
  }

  console.log("\n=== 3. Delta pub→insert por fuente (últimas 48h; min negativos = pub futura) ===");
  console.log(
    await rows(sql`
      SELECT source,
        count(*)::int AS n,
        round(avg(EXTRACT(EPOCH FROM (created_at - published_at)) / 60))::int AS avg_lag_min,
        round(min(EXTRACT(EPOCH FROM (created_at - published_at)) / 60))::int AS min_lag_min
      FROM news
      WHERE created_at >= now() - interval '48 hours'
      GROUP BY source ORDER BY min_lag_min ASC LIMIT 25
    `),
  );

  console.log("\n=== 4. news_tickers por extraction_method (últimas 48h) ===");
  console.log(
    await rows(sql`
      SELECT nt.extraction_method, split_part(n.source, ':', 1) AS src, count(*)::int AS n
      FROM news_tickers nt JOIN news n ON n.id = nt.news_id
      WHERE n.created_at >= now() - interval '48 hours'
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 15
    `),
  );

  console.log("\n=== 5. Muestras gnews: ticker atribuido vs headline (30 aleatorias 48h) ===");
  for (const r of await rows<{ ticker: string; headline: string; source: string }>(sql`
    SELECT nt.ticker, n.headline, n.source
    FROM news_tickers nt JOIN news n ON n.id = nt.news_id
    WHERE n.source LIKE 'gnews:%' AND n.created_at >= now() - interval '48 hours'
    ORDER BY random() LIMIT 30
  `)) {
    console.log(`${r.ticker.padEnd(6)} ${r.headline.slice(0, 90)}`);
  }

  console.log("\n=== 6. Inserciones por hora (últimas 24h) — cadencia real del cron ===");
  console.log(
    await rows(sql`
      SELECT date_trunc('hour', created_at) AS hour, count(*)::int AS n
      FROM news WHERE created_at >= now() - interval '24 hours'
      GROUP BY 1 ORDER BY 1 DESC
    `),
  );

  console.log("\n=== 7. Backlog scoring ===");
  console.log(
    await rows(sql`
      SELECT
        count(*) FILTER (WHERE s.news_id IS NULL)::int AS unscored,
        count(*)::int AS with_ticker_total
      FROM news n
      JOIN news_tickers nt ON nt.news_id = n.id
      LEFT JOIN news_scores s ON s.news_id = n.id
    `),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
