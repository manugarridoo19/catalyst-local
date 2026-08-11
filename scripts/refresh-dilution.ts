// Refresco manual de `ticker_dilution` (XBRL de la SEC).
//
//   pnpm dilution:refresh [--force] [SYM...]

import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { runRefreshDilutionCron } = await import("../lib/cron/refresh-dilution");
  const force = process.argv.includes("--force");
  const symbols = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const r = await runRefreshDilutionCron({
    force,
    symbols: symbols.length ? symbols.map((s) => s.toUpperCase()) : undefined,
  });
  console.log(
    `[dilution] ${r.refreshed}/${r.symbols} refrescados · ${r.empty} sin cobertura`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[dilution] FATAL:", e);
    process.exit(1);
  });
