// Cron runner para GitHub Actions. Ejecuta refresh + score en el runner
// mismo (ubuntu-latest gratuito en repos públicos), conectándose
// directamente a Neon, Pusher y los LLM. Vercel queda fuera del path
// del cron — su CPU sólo se consume cuando un usuario abre la UI.
//
// Las env vars se inyectan vía GitHub Secrets en el workflow. En local
// se cargan de .env.local para test (`pnpm cron:remote`).

import { config } from "dotenv";

// Dynamic imports después de cargar .env — los static imports se hoistean
// antes de config() y perderíamos las env vars al importar lib/db.
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const t0 = Date.now();
  const { runRefreshNewsCron } = await import("../lib/cron/refresh-news");
  const { runScoreOrphansCron } = await import("../lib/cron/score-orphans");

  console.log("[cron-runner] refresh-news start");
  const refresh = await runRefreshNewsCron();
  console.log(
    `[cron-runner] refresh done in ${refresh.durationMs}ms:`,
    JSON.stringify({
      inserted: refresh.inserted,
      fetched: refresh.fetched,
      enriched: refresh.enriched,
    }),
  );

  console.log("[cron-runner] score-orphans start");
  const score = await runScoreOrphansCron();
  console.log(
    `[cron-runner] score done in ${score.durationMs}ms:`,
    JSON.stringify({
      picked: score.picked,
      scored: score.scored,
      failed: score.failed,
    }),
  );

  console.log(`[cron-runner] total ${Date.now() - t0}ms`);
}

main()
  .then(() => {
    // Forzar salida — postgres-js + Pusher dejan handles abiertos
    // (connection pool, websocket) que evitan que Node termine solo
    // y agotaríamos el timeout del runner.
    process.exit(0);
  })
  .catch((err) => {
    console.error("[cron-runner] FAILED:", err);
    process.exit(1);
  });
