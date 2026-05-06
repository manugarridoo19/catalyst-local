// Script local para ejecutar el cron sin levantar Next. Útil para test
// rápido del pipeline antes del primer deploy.
//
//   pnpm cron:local
//
// Asume que .env.local está rellenado.

import { config } from "dotenv";

// IMPORTANTE: dynamic import — los static imports se hoistean antes de
// `config()`, así que perderíamos las env vars al cargar `lib/db`.
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { runRefreshNewsCron } = await import("../lib/cron/refresh-news");
  console.log("[cron] running refresh-news...");
  const result = await runRefreshNewsCron();
  console.log("[cron] result:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
