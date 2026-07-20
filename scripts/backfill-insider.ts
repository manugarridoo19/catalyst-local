// Backfill one-shot de datos insider estructurados: recorre los filings
// sec-edgar YA ingeridos como noticias (retención 20d) que aún no tienen
// intento de parseo (news.insider_parsed_at IS NULL) y los pasa por el
// mismo camino que usa el cron (ingestInsiderData) en lotes, hasta agotar.
//
//   pnpm exec tsx scripts/backfill-insider.ts [maxFilings]
//
// Respeta el rate-limit SEC (gap entre filings dentro de ingestInsiderData).

import { config } from "dotenv";
config({ path: ".env.local" });

const BATCH = 25;
const LOOKBACK_HOURS = 21 * 24; // toda la retención de news

async function main() {
  const max = Number(process.argv[2] ?? 600);
  const { ingestInsiderData } = await import("../lib/insider/ingest");

  let total = { scanned: 0, trades: 0, stakes: 0, failed: 0 };
  while (total.scanned < max) {
    const r = await ingestInsiderData({
      limit: Math.min(BATCH, max - total.scanned),
      lookbackHours: LOOKBACK_HOURS,
    });
    if (r.scanned === 0) break;
    total = {
      scanned: total.scanned + r.scanned,
      trades: total.trades + r.trades,
      stakes: total.stakes + r.stakes,
      failed: total.failed + r.failed,
    };
    console.log(
      `[backfill-insider] +${r.scanned} filings (${r.trades} trades, ${r.stakes} stakes, ${r.failed} failed) — total ${total.scanned}`,
    );
  }
  console.log(
    `[backfill-insider] DONE: ${total.scanned} filings → ${total.trades} trades, ${total.stakes} stakes, ${total.failed} failed`,
  );
}

main()
  .then(() => process.exit(0)) // driver deja handles abiertos
  .catch((e) => {
    console.error("[backfill-insider] FATAL:", e);
    process.exit(1);
  });
