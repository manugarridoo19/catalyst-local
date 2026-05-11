import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

// Rescore total. WIPE de news_scores + repuntuar TODAS las news con ticker
// usando el modelo OpenRouter actual y prompt v3.3.
//
// Uso:
//   pnpm tsx scripts/rescore-all.ts           # rescore TODO
//   pnpm tsx scripts/rescore-all.ts --keep    # solo scorear orphans, sin wipe
//   pnpm tsx scripts/rescore-all.ts --limit 500   # cap manual

const args = new Set(process.argv.slice(2));
const KEEP = args.has("--keep");
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split("=")[1]) : null;
// Concurrencia=1 porque owl-alpha rate-limita brutal (429 tras una call).
// Sumamos delay entre llamadas. Si quieres ir más rápido vía Groq directo:
//   SCORER_PRIMARY=groq pnpm tsx scripts/rescore-all.ts
const CONCURRENCY = 1;
const PER_CALL_DELAY_MS = 1500;

type Row = {
  id: number;
  headline: string;
  body: string | null;
  source: string;
  tickers: string[];
};

function unwrap(r: unknown): Row[] {
  const w = r as { rows?: Row[] };
  return (w.rows ?? (r as Row[])) as Row[];
}

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");
  const { scoreNewsItem } = await import("../lib/scoring");
  const { insertScore } = await import("../lib/db/queries");

  if (!KEEP) {
    console.log("[rescore-all] WIPE news_scores …");
    await db.execute(sql`DELETE FROM news_scores`);
    console.log("[rescore-all] wiped.");
  } else {
    console.log("[rescore-all] --keep: skipping wipe, scoring only orphans");
  }

  const limitClause = LIMIT ? sql`LIMIT ${LIMIT}` : sql``;
  const raw = await db.execute(sql`
    SELECT n.id, n.headline, n.body, n.source,
      ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
    FROM news n
    WHERE NOT EXISTS (SELECT 1 FROM news_scores s WHERE s.news_id = n.id)
      AND EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
    ORDER BY n.published_at DESC
    ${limitClause}
  `);
  const rows = unwrap(raw);

  console.log(`[rescore-all] ${rows.length} news a scorear, concurrency=${CONCURRENCY}`);

  const t0 = Date.now();
  let done = 0;
  let scored = 0;
  let failed = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
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
          if (scored % 25 === 0) {
            const elapsed = (Date.now() - t0) / 1000;
            const rate = scored / elapsed;
            const eta = (rows.length - done) / rate;
            console.log(
              `  ${scored}/${rows.length} scored (${rate.toFixed(1)}/s, ETA ${(eta / 60).toFixed(1)}m)`,
            );
          }
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
        console.warn(
          `  ✕ ${r.id}: ${err instanceof Error ? err.message.slice(0, 100) : err}`,
        );
      } finally {
        done++;
        if (PER_CALL_DELAY_MS > 0) {
          await new Promise((r) => setTimeout(r, PER_CALL_DELAY_MS));
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n[rescore-all] DONE: ${scored} scored, ${failed} failed in ${elapsed}s`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
