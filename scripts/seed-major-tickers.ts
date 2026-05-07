// One-shot: inserta los tickers populares (TICKER_SEEDS) en la tabla
// `tickers` y todos sus alias en `ticker_aliases`. Idempotente —
// `onConflictDoNothing` evita duplicados si lo corres dos veces.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { TICKER_SEEDS } = await import("../lib/tickers/seed-list");
  const { db } = await import("../lib/db");
  const { tickers, tickerAliases } = await import("../lib/db/schema");

  let tickerInserts = 0;
  let aliasInserts = 0;

  for (const seed of TICKER_SEEDS) {
    const tickerInserted = await db
      .insert(tickers)
      .values({ symbol: seed.symbol, name: seed.name, source: "seed" })
      .onConflictDoNothing()
      .returning({ symbol: tickers.symbol });
    if (tickerInserted.length) tickerInserts++;

    for (const alias of seed.aliases) {
      const aliasInserted = await db
        .insert(tickerAliases)
        .values({ alias, symbol: seed.symbol })
        .onConflictDoNothing()
        .returning({ alias: tickerAliases.alias });
      if (aliasInserted.length) aliasInserts++;
    }
  }

  console.log(
    `[seed] inserted ${tickerInserts} new tickers + ${aliasInserts} aliases (out of ${TICKER_SEEDS.length} seeds)`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
