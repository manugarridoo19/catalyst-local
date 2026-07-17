// Recorta ráfagas de Form 4 ya ingeridas: conserva los N más recientes por
// emisor y día (UTC), borra el resto. Espejo one-time del cap de ingesta
// (SEC_FORM4_PER_ISSUER_CAP) para limpiar el backlog acumulado antes del
// cap. El borrado cascada limpia news_tickers / news_scores /
// article_extracts.
//
//   pnpm exec tsx scripts/cleanup-insider-bursts.ts            # dry-run
//   pnpm exec tsx scripts/cleanup-insider-bursts.ts --apply    # ejecuta
//
// Solo toca Form 4 de sec-edgar (titular "… files Form 4 (insider)").
import { config } from "dotenv";
config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

const CAP = Number(process.env.SEC_FORM4_PER_ISSUER_CAP ?? 3);
const APPLY = process.argv.includes("--apply");

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Rank por emisor (headline) + día UTC, más reciente primero. Los que
  // exceden el cap son excedente borrable.
  const ranked = sql`
    SELECT id FROM (
      SELECT id,
        row_number() OVER (
          PARTITION BY headline, (published_at AT TIME ZONE 'utc')::date
          ORDER BY published_at DESC
        ) AS rk
      FROM news
      WHERE source = 'sec-edgar'
        AND headline LIKE '% files Form 4 (insider)'
    ) t WHERE rk > ${CAP}`;

  const excess = await ranked;
  console.log(`Form 4 excedentes (>${CAP}/emisor/día): ${excess.length}`);
  if (!excess.length) return;

  if (!APPLY) {
    const preview = await sql`
      SELECT headline, count(*)::int AS keep_plus_excess
      FROM news
      WHERE source='sec-edgar' AND headline LIKE '% files Form 4 (insider)'
        AND published_at >= now() - interval '2 days'
      GROUP BY headline HAVING count(*) > ${CAP}
      ORDER BY count(*) DESC LIMIT 12`;
    console.log("\nTop emisores (últimas 48h, filas actuales):");
    for (const r of preview) console.log(`  ${r.keep_plus_excess}× ${r.headline}`);
    console.log(`\nDRY-RUN. Ejecuta con --apply para borrar ${excess.length} filas.`);
    return;
  }

  const ids = excess.map((r) => Number(r.id));
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await sql`DELETE FROM news WHERE id = ANY(${chunk})`;
    deleted += chunk.length;
    console.log(`  borradas ${deleted}/${ids.length}…`);
  }
  console.log(`Hecho: ${deleted} Form 4 excedentes borrados (cascada limpió tickers/scores/extracts).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
