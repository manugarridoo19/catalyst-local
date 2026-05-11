import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

// Rescore selectivo: pasa por owl-alpha SOLO las noticias high-impact
// (i≥4) que ahora mismo están scoreadas con Groq 8b. Owl-alpha es ~30×
// más caro en latencia pero da mucha mejor calidad — y son justo las
// noticias accionables donde la calidad importa más.
//
// Uso:
//   pnpm tsx scripts/rescore-high-impact.ts
//   pnpm tsx scripts/rescore-high-impact.ts --limit 50
//   pnpm tsx scripts/rescore-high-impact.ts --min-impact 3   # más agresivo
//
// Variables que conviene tener seteadas (override en el comando):
//   SCORER_PRIMARY=openrouter
//   OPENROUTER_MODEL=openrouter/owl-alpha
//
// Owl-alpha tiene worker pool ~2-3, así que CONCURRENCY=1 con delay
// pequeño es lo óptimo. Cada call ~5-10s; 100 items ≈ 15min.

const args = new Set(process.argv.slice(2));
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split("=")[1]) : null;
const MIN_IMPACT_ARG = process.argv.find((a) => a.startsWith("--min-impact="));
const MIN_IMPACT = MIN_IMPACT_ARG ? Number(MIN_IMPACT_ARG.split("=")[1]) : 4;
const DRY = args.has("--dry");
const PER_CALL_DELAY_MS = 800;

type Row = {
  id: number;
  headline: string;
  body: string | null;
  source: string;
  tickers: string[];
  impact: number;
  sentiment: number;
  model: string;
};

const unwrap = (r: unknown): Row[] => {
  const w = r as { rows?: Row[] };
  return (w.rows ?? (r as Row[])) as Row[];
};

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY no está set. Aborto.");
    process.exit(1);
  }

  // Forzamos owl-alpha como primary. OVERRIDE INCONDICIONAL — si .env.local
  // tiene OPENROUTER_MODEL apuntando a otro modelo (ej. el fantasma viejo),
  // el `||` lo respetaba en vez de owl-alpha. Lo pisamos siempre.
  process.env.SCORER_PRIMARY = "openrouter";
  process.env.OPENROUTER_MODEL = "openrouter/owl-alpha";

  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");
  const { scoreNewsItem } = await import("../lib/scoring");
  const { insertScore } = await import("../lib/db/queries");

  const limitClause = LIMIT ? sql`LIMIT ${LIMIT}` : sql``;
  // Cogemos noticias high-impact que NO se hayan ya rescoreado con owl-alpha.
  // Prioridad: más recientes primero (las viejas perderán retención pronto).
  const raw = await db.execute(sql`
    SELECT n.id, n.headline, n.body, n.source,
      s.impact, s.sentiment, s.model,
      ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
    FROM news n
    JOIN news_scores s ON s.news_id = n.id
    WHERE s.impact >= ${MIN_IMPACT}
      AND s.model NOT LIKE '%owl%'
      AND EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
    ORDER BY n.published_at DESC
    ${limitClause}
  `);
  const rows = unwrap(raw);
  console.log(
    `[rescore-high-impact] ${rows.length} items con impact≥${MIN_IMPACT} y model≠owl${DRY ? " (dry run)" : ""}`,
  );
  console.log(`[rescore-high-impact] model: ${process.env.OPENROUTER_MODEL}, delay: ${PER_CALL_DELAY_MS}ms`);

  const t0 = Date.now();
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  const changes: Array<{ id: number; before: string; after: string; head: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const score = await scoreNewsItem({
        headline: r.headline,
        body: r.body ?? undefined,
        tickers: r.tickers ?? [],
        source: r.source,
      });
      if (!score) {
        failed++;
        process.stdout.write("✕");
        continue;
      }
      const sigDiff = score.impact !== r.impact;
      const sentDiff = score.sentiment !== r.sentiment;
      const isOwl = (score.model ?? "").toLowerCase().includes("owl");
      if (sigDiff || sentDiff || isOwl) {
        if (!DRY) await insertScore(r.id, score);
        updated++;
        if (sigDiff || sentDiff) {
          changes.push({
            id: r.id,
            before: `i${r.impact} s${r.sentiment}`,
            after: `i${score.impact} s${score.sentiment}`,
            head: r.headline.slice(0, 80),
          });
        }
      } else {
        unchanged++;
      }
      process.stdout.write(sigDiff || sentDiff ? "Δ" : ".");
    } catch (err) {
      failed++;
      process.stdout.write("✕");
      if (failed <= 3) {
        console.log(`\n  err ${r.id}: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
      }
    }

    if ((i + 1) % 25 === 0) {
      const elapsed = (Date.now() - t0) / 1000;
      console.log(
        `\n  ${i + 1}/${rows.length}  Δ=${updated} fail=${failed} (${(elapsed / 60).toFixed(1)}min)`,
      );
    }
    await new Promise((r) => setTimeout(r, PER_CALL_DELAY_MS));
  }

  const totalMin = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\n\n[rescore-high-impact] DONE in ${totalMin}min`);
  console.log(`  updated:   ${updated}`);
  console.log(`  unchanged: ${unchanged}`);
  console.log(`  failed:    ${failed}`);

  if (changes.length) {
    console.log(`\nTop changes (max 30):`);
    for (const c of changes.slice(0, 30)) {
      console.log(`  [${c.id}] ${c.before} → ${c.after}  ${c.head}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
