import { config } from "dotenv";
config({ path: ".env.local" });

// Refresca `ticker_metrics` a mano (mismo job que el cron; respeta el guard
// de 20h por símbolo en job_state).
//   pnpm exec tsx scripts/refresh-metrics.ts
//   pnpm exec tsx scripts/refresh-metrics.ts --force   ← ignora el guard
async function main() {
  const force = process.argv.includes("--force");
  if (force) {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("../lib/db");
    // Borra sólo las marcas de ESTE job: `metrics:SYM`. Un DELETE sin el
    // patrón se llevaría por delante los guards de earnings, 13F y los
    // tombstones de filings rotos.
    await db.execute(sql`DELETE FROM job_state WHERE key LIKE 'metrics:%'`);
    console.log("[metrics] guards borrados (--force)");
  }
  const { runRefreshMetricsCron } = await import("../lib/cron/refresh-metrics");
  const t0 = Date.now();
  const r = await runRefreshMetricsCron();
  console.log(
    `[metrics] ${r.refreshed}/${r.symbols} refrescados · ${r.empty} sin cobertura · ${r.failed} fallidos · ${Date.now() - t0}ms`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[metrics] FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
