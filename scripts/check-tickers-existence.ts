import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { inArray } = await import("drizzle-orm");
  const { db } = await import("../lib/db");
  const { tickers } = await import("../lib/db/schema");

  const candidates = ["MBIA", "MKTX", "RDNT", "CPT", "EVH", "ESS", "ES", "HMC", "LUMN", "GPK", "PRMW", "AAPL", "MSFT"];
  const found = await db
    .select({ symbol: tickers.symbol, name: tickers.name })
    .from(tickers)
    .where(inArray(tickers.symbol, candidates));
  console.log("Found in tickers table:");
  console.table(found);
  console.log("\nMissing:", candidates.filter((c) => !found.find((f) => f.symbol === c)));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
