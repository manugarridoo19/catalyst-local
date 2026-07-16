// One-shot refresh tick para el LaunchAgent local (com.catalyst.refresher).
// GitHub Actions throttlea el cron de repos públicos a 1-4h reales; este
// agente corre cada 10 min desde el Mac y mantiene el feed fresco durante
// el día de trading. El dedupe por hash hace que el solape con el cron
// remoto sea gratis.
//
//   pnpm exec tsx scripts/refresh-once.ts
//
// NO scorea (eso es del scorer agent) y NO llama a Marketaux si
// SKIP_MARKETAUX=1 (cuota free 100 req/día — a cadencia 10min la
// agotaríamos; Marketaux sigue entrando vía GH Actions).

import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { runRefreshNewsCron } = await import("../lib/cron/refresh-news");
  const res = await runRefreshNewsCron();
  console.log(
    `[refresh-once] fetched f=${res.fetched.finnhub} fc=${res.fetched.finnhubCompany} mx=${res.fetched.marketaux} rss=${res.fetched.rss} gn=${res.fetched.gnewsTickers} → inserted=${res.inserted} enriched=${res.enriched.succeeded}/${res.enriched.processed} in ${(res.durationMs / 1000).toFixed(1)}s`,
  );
}

main()
  .then(() => process.exit(0)) // postgres + Pusher dejan handles abiertos
  .catch((e) => {
    console.error("[refresh-once] FATAL:", e);
    process.exit(1);
  });
