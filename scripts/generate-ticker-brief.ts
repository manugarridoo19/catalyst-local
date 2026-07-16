import { config } from "dotenv";
config({ path: ".env.local" });

// Genera (o sirve de caché) el Ticker Day Brief de un símbolo.
//   pnpm exec tsx scripts/generate-ticker-brief.ts MSFT
async function main() {
  const symbol = (process.argv[2] ?? "").toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    console.error("usage: pnpm exec tsx scripts/generate-ticker-brief.ts <SYMBOL>");
    process.exit(1);
  }
  const { maybeGenerateTickerBrief } = await import("../lib/ai/ticker-brief");
  const { brief, status } = await maybeGenerateTickerBrief(symbol);
  console.log(`[ticker-brief] ${symbol} status=${status}`);
  if (brief) {
    console.log(
      `[ticker-brief] model=${brief.model} newsCount=${brief.newsCount} at=${brief.generatedAt.toISOString()}\n`,
    );
    console.log(brief.content);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ticker-brief] FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
