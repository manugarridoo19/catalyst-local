// Recorre las noticias sin score y las puntúa con Groq (primario). Útil
// para llenar la columna sentiment de las ~1100 noticias acumuladas que
// quedaron sin scoring por OpenRouter rate-limit.
//
//   pnpm tsx scripts/backfill-scores.ts [maxItems]

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const MAX_DEFAULT = 500;

async function main() {
  const max = Number(process.argv[2]) || MAX_DEFAULT;
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");
  const { scoreNewsItem } = await import("../lib/scoring");
  const { insertScore } = await import("../lib/db/queries");

  const orphaned = await db.execute(sql`
    SELECT n.id, n.headline, n.body, n.source,
      ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
    FROM news n
    WHERE n.id NOT IN (SELECT news_id FROM news_scores)
      AND EXISTS (SELECT 1 FROM news_tickers WHERE news_id = n.id)
    ORDER BY n.published_at DESC
    LIMIT ${max}
  `);

  const rows = (orphaned.rows ?? orphaned) as Array<{
    id: number;
    headline: string;
    body: string | null;
    source: string;
    tickers: string[];
  }>;

  console.log(`[backfill-scores] ${rows.length} news to score`);

  let scored = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const score = await scoreNewsItem({
        headline: r.headline,
        body: r.body ?? undefined,
        tickers: r.tickers ?? [],
        source: r.source,
      });
      if (score) {
        await insertScore(r.id, score);
        scored++;
        const dir = score.sentiment > 0 ? "+" : "";
        process.stdout.write(
          `  ${String(r.id).padEnd(5)} impact=${score.impact} sent=${dir}${score.sentiment} · ${r.headline.slice(0, 60)}\n`,
        );
      } else {
        failed++;
        process.stdout.write(`  ${String(r.id).padEnd(5)} ✕ unscored\n`);
      }
    } catch (err) {
      failed++;
      process.stdout.write(
        `  ${String(r.id).padEnd(5)} ERR ${err instanceof Error ? err.message.slice(0, 60) : err}\n`,
      );
    }
    // Groq free 30 req/min. 4s entre requests = 15/min — bien por debajo
    // del límite para no provocar 429 cascadas. El client tiene retry
    // interno con backoff por si acaso. Mejor lento y fiable que rápido y
    // fallido.
    await new Promise((r) => setTimeout(r, 4000));

    if ((i + 1) % 25 === 0) {
      console.log(`[backfill-scores] progress: ${i + 1}/${rows.length} (${scored} scored, ${failed} failed)`);
    }
  }
  console.log(`[backfill-scores] done: ${scored}/${rows.length} scored, ${failed} failed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
