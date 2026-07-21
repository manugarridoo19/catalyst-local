// Backfill del archivo consultable (Ask Catalyst): embebe todas las
// noticias impact>=3 que aún no lo estén, no sólo las del último tick.
// En producción esto lo hace solo el tick de scoring; este script es para
// la puesta al día inicial (~6k filas vivas el 2026-07-21).
//
//   pnpm signals:embed              # hasta agotar candidatos o cuota
//   pnpm signals:embed 500          # tope de filas
//   pnpm signals:embed --dry-run    # sólo cuenta lo pendiente
//
// Ritmo: el free tier de Gemini da 100 embeddings/min y key (cada TEXTO
// cuenta, no cada batch), así que entre lote y lote esperamos lo justo
// para no comerte el pool a base de 429.

import { config } from "dotenv";
config({ path: ".env.local" });

const SLEEP_MS = Number(process.env.EMBED_SLEEP_MS ?? 20_000);

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const maxRows = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 0);

  const { sql } = await import("drizzle-orm");
  const { db, unwrapRows } = await import("../lib/db");

  const pending = unwrapRows<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n
      FROM news n
      JOIN news_scores s ON s.news_id = n.id
      LEFT JOIN news_embeddings e ON e.news_id = n.id
      WHERE s.impact >= 3 AND e.id IS NULL
    `),
  )[0]?.n ?? 0;
  const already = unwrapRows<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM news_embeddings`),
  )[0]?.n ?? 0;
  console.log(`[embed-backfill] ${already} embebidas, ${pending} pendientes`);
  if (dryRun || pending === 0) return;

  const { runEmbedIngest } = await import("../lib/embeddings/ingest");
  let total = 0;
  for (;;) {
    const r = await runEmbedIngest();
    total += r.embedded;
    console.log(
      `[embed-backfill] +${r.embedded} (total ${total}) db=${r.dbMb.toFixed(0)}MB${r.skipped ? ` skipped=${r.skipped}` : ""}`,
    );
    // Parar en seco ante cualquier freno: cuota agotada, disco al límite o
    // simplemente no quedan candidatos. Reintentar aquí sólo quemaría 429s.
    if (r.skipped || r.embedded === 0) break;
    if (maxRows && total >= maxRows) break;
    await new Promise((res) => setTimeout(res, SLEEP_MS));
  }
  console.log(`[embed-backfill] hecho: ${total} embeddings nuevos`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
