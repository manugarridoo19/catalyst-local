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
      unlinked: score.unlinked,
    }),
  );

  // AI Brief: regenera solo si el último tiene >4h (age check dentro).
  // Un fallo aquí no tumba el cron — el dashboard conserva el anterior.
  try {
    const { maybeGenerateBrief } = await import("../lib/ai/brief");
    const brief = await maybeGenerateBrief();
    console.log(
      brief.generated
        ? `[cron-runner] brief regenerated (${brief.brief?.model})`
        : "[cron-runner] brief still fresh — skipped",
    );
  } catch (err) {
    console.warn(
      "[cron-runner] brief generation failed (keeping previous):",
      err instanceof Error ? err.message : err,
    );
  }

  // Earnings calendar de la watchlist (Finnhub, ~1 fetch/símbolo/día).
  try {
    const { runRefreshEarningsCron } = await import(
      "../lib/cron/refresh-earnings"
    );
    const e = await runRefreshEarningsCron();
    if (e.refreshed > 0) {
      console.log(
        `[cron-runner] earnings refreshed ${e.refreshed}/${e.symbols} symbols (${e.events} events)`,
      );
    }
  } catch (err) {
    console.warn(
      "[cron-runner] earnings refresh failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // AI Picks: mismo patrón que el brief (age check 4h, fallo no tumba).
  try {
    const { maybeGeneratePicks } = await import("../lib/ai/picks");
    const picks = await maybeGeneratePicks();
    console.log(
      picks.generated
        ? `[cron-runner] picks regenerated (${picks.picks?.model}, ${picks.picks?.picks.length} picks)`
        : "[cron-runner] picks still fresh — skipped",
    );
  } catch (err) {
    console.warn(
      "[cron-runner] picks generation failed (keeping previous):",
      err instanceof Error ? err.message : err,
    );
  }

  // Smart Money digest (sección /insider): age check 6h, fallo no tumba.
  try {
    const { maybeGenerateInsiderDigest } = await import(
      "../lib/ai/insider-digest"
    );
    const digest = await maybeGenerateInsiderDigest();
    console.log(
      digest.generated
        ? `[cron-runner] insider digest regenerated (${digest.digest?.model})`
        : "[cron-runner] insider digest still fresh — skipped",
    );
  } catch (err) {
    console.warn(
      "[cron-runner] insider digest failed (keeping previous):",
      err instanceof Error ? err.message : err,
    );
  }

  // 13F de los fondos curados. Trimestral: casi todas las pasadas salen por
  // el guard sin tocar la red. Va antes de la detección para que una apertura
  // recién publicada entre en el registro en el mismo tick.
  try {
    const { runFundHoldingsIngest } = await import("../lib/funds/ingest");
    const fh = await runFundHoldingsIngest();
    if (fh.filingsStored > 0) {
      console.log(
        `[cron-runner] 13F +${fh.filingsStored} filings, ${fh.holdingsStored} posiciones (${fh.fundsChecked} fondos)`,
      );
    }
  } catch (err) {
    console.warn(
      "[cron-runner] fund holdings failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Comunicados de resultados de la watchlist (8-K item 2.02 → exhibit 99.1).
  // Barrido cada 6h; en régimen hace 0 llamadas LLM (una empresa presenta una
  // vez por trimestre) y sólo gasta el día que aparece un comunicado nuevo.
  try {
    const { runEarningsReportsIngest } = await import("../lib/earnings/ingest");
    const er = await runEarningsReportsIngest();
    if (er.generated > 0) {
      console.log(
        `[cron-runner] earnings reports +${er.generated} (${er.checked} símbolos revisados)`,
      );
    }
  } catch (err) {
    console.warn(
      "[cron-runner] earnings reports failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Short interest de FINRA. Va ANTES de la detección de señales para que el
  // squeeze setup vea la quincena nueva en el mismo tick en que llega. Casi
  // siempre sale por el guard sin tocar la red: el dato se publica 2×/mes.
  try {
    const { runShortInterestIngest } = await import(
      "../lib/short-interest/ingest"
    );
    const si = await runShortInterestIngest();
    if (si.stored > 0) {
      console.log(
        `[cron-runner] short interest ${si.settlementDate}: ${si.stored}/${si.fetched} filas en ${si.durationMs}ms`,
      );
    }
  } catch (err) {
    console.warn(
      "[cron-runner] short interest failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Signal Lab — registro PROSPECTIVO de señales. Va después de picks e
  // insider digest a propósito: así los picks recién generados en este mismo
  // tick ya entran en el registro. Inserts idempotentes, cero LLM.
  try {
    const { runDetectSignalsCron } = await import("../lib/signals/detect");
    const sig = await runDetectSignalsCron();
    if (sig.inserted > 0) {
      console.log(
        `[cron-runner] signals +${sig.inserted}`,
        JSON.stringify(sig.byKind),
      );
    }
  } catch (err) {
    console.warn(
      "[cron-runner] signal detection failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Outcomes: mide señales maduras contra los precios posteriores. Chunked
  // con presupuesto de tiempo, pero OJO: el guard global de outcomes.ts hace
  // que corra 1×/20h — lo que no entre en una pasada espera a la de MAÑANA,
  // no al siguiente tick. Capacidad real ≈ OUTCOMES_MAX_SYMBOLS símbolos/día;
  // si el backlog de símbolos pendientes creciera por encima, subir ese env.
  try {
    const { runSignalOutcomesCron } = await import("../lib/signals/outcomes");
    const out = await runSignalOutcomesCron({
      maxSymbols: Number(process.env.OUTCOMES_MAX_SYMBOLS ?? 12),
    });
    if (out.eventsProcessed > 0) {
      console.log(
        `[cron-runner] outcomes filled ${out.outcomesFilled} over ${out.eventsProcessed} events / ${out.symbols} symbols` +
          (out.abandoned ? ` (${out.abandoned} abandoned)` : "") +
          ` in ${out.durationMs}ms`,
      );
    }
  } catch (err) {
    console.warn(
      "[cron-runner] signal outcomes failed:",
      err instanceof Error ? err.message : err,
    );
  }

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
