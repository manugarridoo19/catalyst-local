// Standalone test of the analyst-action suppression in extractTickers.
// Run: pnpm tsx scripts/test-extractor-analyst.ts

import { extractTickers, type TickerAlias } from "../lib/tickers/extractor";
import type { NormalizedNewsItem } from "../lib/types";

const aliases: TickerAlias[] = [
  { alias: "JPMorgan", symbol: "JPM" },
  { alias: "JP Morgan", symbol: "JPM" },
  { alias: "Morgan Stanley", symbol: "MS" },
  { alias: "Bank of America", symbol: "BAC" },
  { alias: "BofA", symbol: "BAC" },
  { alias: "Goldman Sachs", symbol: "GS" },
  { alias: "Citi", symbol: "C" },
  { alias: "Cantor Fitzgerald", symbol: "CEPT" },
  { alias: "Tesla", symbol: "TSLA" },
  { alias: "Apple", symbol: "AAPL" },
  { alias: "Vista", symbol: "VIST" },
  { alias: "Celanese", symbol: "CE" },
  { alias: "McDonald", symbol: "MCD" },
  { alias: "Molina Healthcare", symbol: "MOH" },
  { alias: "Nebius", symbol: "NBIS" },
];

function mkItem(headline: string, apiTickers: string[] = []): NormalizedNewsItem {
  return {
    sourceId: "test",
    url: "https://example.com/" + headline.replace(/\W+/g, "-"),
    headline,
    body: "",
    publishedAt: new Date(),
    apiTickers,
    sourceName: "test",
  };
}

type Case = { name: string; headline: string; api?: string[]; expectInclude?: string[]; expectExclude?: string[] };

const cases: Case[] = [
  {
    name: "JPMorgan raises Vista Oil — suppress JPM, keep VIST via dict",
    headline: "JPMorgan raises Vista Oil stock price target to $93 on acquisition",
    expectInclude: ["VIST"],
    expectExclude: ["JPM"],
  },
  {
    name: "JPMorgan upgrades Celanese — suppress JPM, keep CE",
    headline: "JPMorgan upgrades Celanese stock rating on valuation, cash flow",
    expectInclude: ["CE"],
    expectExclude: ["JPM"],
  },
  {
    name: "JPMorgan Cuts McDonald's Price Target",
    headline: "JPMorgan Cuts McDonald’s Price Target to $305: Is the Same-Store-Sales Story Stalling?",
    expectInclude: ["MCD"],
    expectExclude: ["JPM"],
  },
  {
    name: "Cantor Fitzgerald raises Molina (NYSE:MOH)",
    headline: "Cantor Fitzgerald Raises Molina Healthcare (NYSE:MOH) Price Target to $209.00",
    expectInclude: ["MOH"],
    expectExclude: ["CEPT"],
  },
  {
    name: "Bank of America raises Nebius (NASDAQ:NBIS)",
    headline: "Bank of America Raises Nebius Group (NASDAQ:NBIS) Price Target to $205.00",
    expectInclude: ["NBIS"],
    expectExclude: ["BAC"],
  },
  {
    name: "JPMorgan Hikes Kospi — suppress JPM (no real target)",
    headline: "JPMorgan Hikes Kospi Bull Case Target to 10,000 on Memory Boom",
    expectExclude: ["JPM", "GS"],
  },
  {
    name: "JPMorgan Chase & Co. Raises IREN — suppress JPM but keep IREN from parens",
    headline: "JPMorgan Chase & Co. Raises IREN (NASDAQ:IREN) Price Target to $46.00",
    expectInclude: ["IREN"],
    expectExclude: ["JPM"],
  },
  {
    name: "Generic JPM material news — DO NOT suppress",
    headline: "JPMorgan Chase posts record Q1 earnings, beats estimates",
    expectInclude: ["JPM"],
  },
  {
    name: "Tesla news (no analyst pattern) — keep TSLA",
    headline: "Tesla unveils new battery technology at investor day",
    expectInclude: ["TSLA"],
  },
  {
    name: "Piper Sandler cuts Lenz — no bank ticker to suppress",
    headline: "Piper Sandler cuts Lenz Therapeutics stock rating on slow sales",
    expectInclude: [],
    expectExclude: ["JPM", "GS", "MS", "BAC"],
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const item = mkItem(c.headline, c.api ?? []);
  const out = extractTickers(item, aliases);
  const syms = out.map(t => t.symbol);
  const inc = (c.expectInclude ?? []).every(s => syms.includes(s));
  const exc = (c.expectExclude ?? []).every(s => !syms.includes(s));
  const ok = inc && exc;
  if (ok) {
    passed++;
    console.log(`✓ ${c.name}\n  → [${syms.join(",")}]`);
  } else {
    failed++;
    console.log(`✗ ${c.name}`);
    console.log(`  headline: ${c.headline}`);
    console.log(`  got:      [${syms.join(",")}]`);
    if (c.expectInclude?.length) console.log(`  expected include: [${c.expectInclude.join(",")}]`);
    if (c.expectExclude?.length) console.log(`  expected exclude: [${c.expectExclude.join(",")}]`);
  }
}
console.log(`\n${passed}/${cases.length} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
