import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { extractTickers } = await import("../lib/tickers/extractor");
  const { loadAliases, loadKnownSymbols } = await import("../lib/db/queries");
  const [aliases, knownSymbols] = await Promise.all([loadAliases(), loadKnownSymbols()]);

  const cases = [
    { headline: "Helmerich & Payne (HP) Q2 Earnings", body: "" },
    { headline: "Constellation Energy (NASDAQ:CEG) Q1 Earnings Call", body: "" },
    { headline: "PayPal Holdings' (PYPL) Q1 2026 Earnings", body: "" },
    { headline: "Microsoft Stock (NASDAQ:MSFT) Slips as Israeli Connections Examined", body: "" },
    { headline: "Canadian Natural Resources (CNQ) Q1 Earnings: A Look at Key Metrics", body: "" },
    { headline: "Employee gets terminated for refusing to lower his salary", body: "office pressure tactics" },
    { headline: "Goldman Sachs cuts CNH Industrial after stock's strong outperformance", body: "" },
    { headline: "Stellar performance of Q1 makes investors bullish", body: "" },
    { headline: "Canadian Stocks To Watch Today - May 11th", body: "" },
    { headline: "Tesla beat Q1 estimates", body: "" },
    { headline: "Primoris upgraded at Mizuho on bookings growth after Q1 miss (PRIM:NYSE)", body: "" },
    { headline: "What Is the Required Minimum Distribution (RMD) for a $750,000 Account?", body: "" },
    // Nuevos casos — leading ticker pattern
    { headline: "MBIA Q1 Earnings Call Highlights", body: "" },
    { headline: "MKTX Q1 Earnings Beat Estimates", body: "" },
    { headline: "RDNT Reports Q1 Earnings", body: "" },
    { headline: "MSFT's Q1 results beat expectations", body: "" },
    { headline: "EPS Beat Q1 Estimates", body: "" }, // EPS no es ticker → debe ser (none)
    { headline: "USA Sets New Trade Records", body: "" }, // USA en blocklist
  ];

  for (const c of cases) {
    const item = {
      url: "test", hash: "test",
      headline: c.headline,
      body: c.body,
      source: "test", publishedAt: new Date(),
      imageUrl: null, apiTickers: [],
    };
    const tickers = extractTickers(item, aliases, { knownSymbols });
    const summary = tickers.map((t) => `${t.symbol}(${t.method})`).join(", ") || "(none)";
    console.log(`→ ${c.headline.slice(0, 78)}`);
    console.log(`  ${summary}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
