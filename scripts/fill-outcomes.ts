// Pasada manual del job de outcomes del Signal Lab (debug / puesta al día).
// En producción lo dispara el cron-runner en cada tick; esto es el mismo job
// en primer plano.
//
//   pnpm exec tsx scripts/fill-outcomes.ts [maxSymbols]

import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const maxSymbols = Number(process.argv[2] ?? 15);
  const { runSignalOutcomesCron } = await import("../lib/signals/outcomes");
  const res = await runSignalOutcomesCron({
    maxSymbols,
    maxEvents: 500,
    budgetMs: 120_000,
  });
  console.log(
    `[fill-outcomes] ${res.outcomesFilled} outcomes / ${res.eventsProcessed} events / ${res.symbols} symbols` +
      (res.abandoned ? ` (${res.abandoned} abandoned)` : "") +
      ` in ${(res.durationMs / 1000).toFixed(1)}s`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[fill-outcomes] FATAL:", e);
    process.exit(1);
  });
