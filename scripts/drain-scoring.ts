// One-shot local backlog drainer. The GH Actions cron has been
// scoring ~10 news per hour against a firehose of ~100/h, so the
// "—" (pending grading) badges accumulate. Run this locally with
// .env.local credentials to drain a chunk of orphans in one go.
//
//   pnpm tsx scripts/drain-scoring.ts            # default: 200 items
//   pnpm tsx scripts/drain-scoring.ts 500        # explicit count
//
// Respects rate limits via batch size + a pause between batches.
// Aborts cleanly if 3 batches in a row produce 0 scores (= quota
// exhausted) so it doesn't burn the day's free-tier budget.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const TARGET = Math.max(1, parseInt(process.argv[2] ?? "200", 10));
// v4: cada tick de runScoreOrphansCron coge 30 noticias en 3 lotes de 10
// (3 llamadas LLM). El pacing se calcula proporcional al picked del tick.
const BATCH = 30;

// Adaptive pacing: empezamos en 4s (mismo que antes). Si un tick scored
// <3, doblamos hasta 30s (Groq rolling window típicamente libera en 30-60s).
// Si scored >=8, halvemos hasta el suelo de 2s para acelerar cuando hay
// holgura. Old 4s fijo daba 6% éxito porque batías la ventana de Groq
// constantemente; este pacing se auto-tunea a la capacidad real.
const PAUSE_MIN_MS = 2000;
const PAUSE_BASE_MS = 4000;
const PAUSE_MAX_MS = 30_000;

async function main() {
  const { runScoreOrphansCron } = await import("../lib/cron/score-orphans");

  let pauseMs = PAUSE_BASE_MS;
  console.log(
    `[drain] target=${TARGET}  batch=${BATCH}  pause=adaptive(${PAUSE_MIN_MS}-${PAUSE_MAX_MS}ms, start=${pauseMs}ms)`,
  );

  let totalScored = 0;
  let totalFailed = 0;
  let zeroRunsInARow = 0;
  let iteration = 0;
  const t0 = Date.now();

  while (totalScored < TARGET) {
    iteration++;
    const res = await runScoreOrphansCron();
    totalScored += res.scored;
    totalFailed += res.failed;

    // Tune pause antes de loggear así el log refleja el próximo pause.
    // Umbrales proporcionales al picked (v4: 30/tick, antes 10).
    const prevPause = pauseMs;
    if (res.picked > 0 && res.scored < res.picked * 0.25) {
      pauseMs = Math.min(PAUSE_MAX_MS, Math.round(pauseMs * 2));
    } else if (res.picked > 0 && res.scored >= res.picked * 0.8) {
      pauseMs = Math.max(PAUSE_MIN_MS, Math.round(pauseMs / 2));
    }
    const pauseTag = pauseMs !== prevPause ? `pause=${pauseMs}ms*` : `pause=${pauseMs}ms`;

    console.log(
      `[drain] tick ${iteration.toString().padStart(3)}  picked=${res.picked.toString().padStart(3)}  scored=${res.scored.toString().padStart(3)}  failed=${res.failed.toString().padStart(3)}  unlinked=${res.unlinked.toString().padStart(3)}  cum=${totalScored}/${TARGET}  ${pauseTag}  +${(res.durationMs / 1000).toFixed(1)}s`,
    );

    if (res.picked === 0) {
      console.log("[drain] no more orphans — done.");
      break;
    }
    if (res.scored === 0) {
      zeroRunsInARow++;
      // Quota verdaderamente agotada: 5 ticks seguidos en 0 con el pause
      // ya en el máximo. Antes era 3 ticks/0 sin considerar pause — un
      // burst de 30s podía abortar drainings sanos.
      if (zeroRunsInARow >= 5 && pauseMs >= PAUSE_MAX_MS) {
        console.log("[drain] 5 ticks scored zero at max pause — quota exhausted. Aborting.");
        break;
      }
    } else {
      zeroRunsInARow = 0;
    }

    if (totalScored < TARGET) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }

  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  const attempts = totalScored + totalFailed;
  const rate = attempts ? ((totalScored / attempts) * 100).toFixed(1) : "0";
  console.log(
    `\n[drain] DONE in ${wall}s — ${totalScored} scored, ${totalFailed} failed across ${iteration} ticks (${rate}% success).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[drain] FATAL:", e);
    process.exit(1);
  });
