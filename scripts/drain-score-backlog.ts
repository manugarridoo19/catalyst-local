// One-shot: dispara N ticks de score-orphans con espaciado para drenar
// backlog acumulado sin pisar el Groq burst limit (≥15 calls/10s → 429).
// Cada tick scorea ORPHAN_BATCH=10 news en ~3-15s, espera 8s, repite.
//
//   pnpm tsx scripts/drain-score-backlog.ts [ticks=10]

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const ticks = Number(process.argv[2] ?? 10);
  const { runScoreOrphansCron } = await import("../lib/cron/score-orphans");

  console.log(`[drain] running ${ticks} score-orphans ticks with 8s spacing\n`);
  let totalScored = 0;
  let totalFailed = 0;

  for (let i = 1; i <= ticks; i++) {
    const t0 = Date.now();
    const r = await runScoreOrphansCron();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    totalScored += r.scored;
    totalFailed += r.failed;
    console.log(
      `[drain] tick ${i}/${ticks}: picked=${r.picked} scored=${r.scored} failed=${r.failed} (${dt}s)`,
    );

    if (r.picked === 0) {
      console.log("[drain] backlog drained, no more orphans");
      break;
    }
    if (i < ticks) {
      await new Promise((res) => setTimeout(res, 8000));
    }
  }

  console.log(`\n[drain] done: ${totalScored} scored, ${totalFailed} failed across ${ticks} ticks`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
