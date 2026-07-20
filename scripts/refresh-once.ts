// One-shot refresh tick para el LaunchAgent local (com.catalyst.refresher).
// GitHub Actions throttlea el cron de repos públicos a 1-4h reales; este
// agente corre cada 10 min desde el Mac y mantiene el feed fresco durante
// el día de trading. El dedupe por hash hace que el solape con el cron
// remoto sea gratis.
//
//   pnpm exec tsx scripts/refresh-once.ts
//
// NO scorea (eso es del scorer agent), NO llama a Marketaux si
// SKIP_MARKETAUX=1 (cuota free 100 req/día — a cadencia 10min la
// agotaríamos; Marketaux sigue entrando vía GH Actions), y NO genera
// brief/picks si SKIP_BRIEFS=1: desde el pinger (2026-07-17) el cron GH
// corre cada ~10min y es el ÚNICO escritor de prosa — dos generadores con
// age-check read-then-generate podían cruzar el umbral de 4h a la vez y
// duplicar la llamada LLM. El plist del refresher fija SKIP_BRIEFS=1.

import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { runRefreshNewsCron } = await import("../lib/cron/refresh-news");
  const res = await runRefreshNewsCron();
  console.log(
    `[refresh-once] fetched f=${res.fetched.finnhub} fc=${res.fetched.finnhubCompany} mx=${res.fetched.marketaux} rss=${res.fetched.rss} gn=${res.fetched.gnewsTickers} sec=${res.fetched.sec} → inserted=${res.inserted} enriched=${res.enriched.succeeded}/${res.enriched.processed} in ${(res.durationMs / 1000).toFixed(1)}s`,
  );

  const skipBriefs = process.env.SKIP_BRIEFS === "1";

  // AI Brief: regenera si el último tiene >4h. Con el age check, aunque
  // este tick corre cada 10min la generación real es ~4-6/día.
  if (!skipBriefs) {
    try {
      const { maybeGenerateBrief } = await import("../lib/ai/brief");
      const brief = await maybeGenerateBrief();
      if (brief.generated) {
        console.log(`[refresh-once] brief regenerated (${brief.brief?.model})`);
      }
    } catch (err) {
      console.warn(
        "[refresh-once] brief generation failed (keeping previous):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Earnings calendar de la watchlist (staleness 20h → ~1 fetch/símbolo/día).
  try {
    const { runRefreshEarningsCron } = await import(
      "../lib/cron/refresh-earnings"
    );
    const e = await runRefreshEarningsCron();
    if (e.refreshed > 0) {
      console.log(
        `[refresh-once] earnings refreshed ${e.refreshed}/${e.symbols} symbols (${e.events} events)`,
      );
    }
  } catch (err) {
    console.warn(
      "[refresh-once] earnings refresh failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // AI Picks: misma cadencia efectiva que el brief (~4-6/día).
  if (!skipBriefs) {
    try {
      const { maybeGeneratePicks } = await import("../lib/ai/picks");
      const picks = await maybeGeneratePicks();
      if (picks.generated) {
        console.log(
          `[refresh-once] picks regenerated (${picks.picks?.model}, ${picks.picks?.picks.length} picks)`,
        );
      }
    } catch (err) {
      console.warn(
        "[refresh-once] picks generation failed (keeping previous):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Smart Money digest (sección /insider): age check 6h dentro.
  if (!skipBriefs) {
    try {
      const { maybeGenerateInsiderDigest } = await import(
        "../lib/ai/insider-digest"
      );
      const digest = await maybeGenerateInsiderDigest();
      if (digest.generated) {
        console.log(
          `[refresh-once] insider digest regenerated (${digest.digest?.model})`,
        );
      }
    } catch (err) {
      console.warn(
        "[refresh-once] insider digest failed (keeping previous):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

main()
  .then(() => process.exit(0)) // postgres + Pusher dejan handles abiertos
  .catch((e) => {
    console.error("[refresh-once] FATAL:", e);
    process.exit(1);
  });
