import { config } from "dotenv";
config({ path: ".env.local" });

// Limpia tickers fantasma con nombres de exchange que se crearon por bug
// del regex anterior (PRIM:NYSE → "NYSE" extracted como ticker).

const FAKE_TICKERS = [
  "NYSE", "NASDAQ", "AMEX", "OTCMKTS", "NYSEARCA",
  "TSX", "LSE", "HKEX", "ASX", "BATS",
  "NASDAQGS", "NASDAQGM", "NASDAQCM",
];

async function main() {
  const { inArray } = await import("drizzle-orm");
  const { db } = await import("../lib/db");
  const { tickers, newsTickers } = await import("../lib/db/schema");

  // 1) Cuántos hay
  const existing = await db
    .select({
      symbol: tickers.symbol,
    })
    .from(tickers)
    .where(inArray(tickers.symbol, FAKE_TICKERS));
  console.log("Fake tickers found:", existing.map((r) => r.symbol).join(", ") || "(none)");

  // 2) Borrar news_tickers (FK cascade no aplica entre estos, mejor explícito)
  const purgedLinks = await db
    .delete(newsTickers)
    .where(inArray(newsTickers.ticker, FAKE_TICKERS))
    .returning({ id: newsTickers.newsId });
  console.log(`Purged ${purgedLinks.length} news_tickers links`);

  // 3) Borrar tickers
  const purgedTickers = await db
    .delete(tickers)
    .where(inArray(tickers.symbol, FAKE_TICKERS))
    .returning({ symbol: tickers.symbol });
  console.log(`Purged tickers: ${purgedTickers.map((t) => t.symbol).join(", ") || "(none)"}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
