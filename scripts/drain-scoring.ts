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
const BATCH = 10;
const PAUSE_MS = 4000; // gentle on Groq burst limits

async function main() {
  const { runScoreOrphansCron } = await import("../lib/cron/score-orphans");

  console.log(`[drain] target=${TARGET}  batch=${BATCH}  pause=${PAUSE_MS}ms`);

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
    console.log(
      `[drain] tick ${iteration.toString().padStart(3)}  picked=${res.picked.toString().padStart(3)}  scored=${res.scored.toString().padStart(3)}  failed=${res.failed.toString().padStart(3)}  cum=${totalScored}/${TARGET}  +${(res.durationMs / 1000).toFixed(1)}s`,
    );

    if (res.picked === 0) {
      console.log("[drain] no more orphans — done.");
      break;
    }
    if (res.scored === 0) {
      zeroRunsInARow++;
      if (zeroRunsInARow >= 3) {
        console.log("[drain] 3 ticks scored zero — quota likely exhausted. Aborting.");
        break;
      }
    } else {
      zeroRunsInARow = 0;
    }

    if (totalScored < TARGET) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }

  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n[drain] DONE in ${wall}s — ${totalScored} scored, ${totalFailed} failed across ${iteration} ticks.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[drain] FATAL:", e);
    process.exit(1);
  });
