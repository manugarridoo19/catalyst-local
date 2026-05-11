import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

// Backfill: añade el "first-word alias" (Dell, Apple, Tesla…) a todos los
// tickers ya enriquecidos. Antes solo guardaba "Dell Technologies" → fallaba
// para headlines tipo "Dell soared 14%". Idempotente.
// También PURGA aliases cortos demasiado genéricos que se hayan colado.

const SHORT_ALIAS_DENYLIST = new Set([
  "american", "united", "national", "general", "first", "federal",
  "international", "global", "world", "new", "northern", "southern",
  "eastern", "western", "central", "atlantic", "pacific", "continental",
  "bank", "banc", "banco", "financial", "trust", "capital", "credit",
  "energy", "industries", "industrial", "networks", "media", "health",
  "tech", "technologies", "technology", "data", "systems", "services",
  "holdings", "holding", "group", "company", "corporation",
  "real", "estate", "advanced", "applied", "alpha", "beta", "core",
  "good", "great", "best", "big", "major", "premier", "prime", "pure",
  "charles", "robert", "james", "william", "thomas", "henry", "george",
  "walt", "morgan", "wells",
  "home", "trade", "block", "delta", "twist", "rise", "fall", "fly",
  "build", "hold", "buy", "sell", "make", "take", "give", "work",
  "live", "save", "lead", "join", "move", "stop", "start", "open",
  "close", "ride", "share", "store", "stock", "stocks",
  "market", "future", "ramp", "boost", "spark", "watch", "winner",
  "target", "sea", "co", "corp", "inc", "ltd", "plc",
]);

function shortAlias(name: string): string | null {
  const cleaned = name
    .replace(/\b(Inc\.?|Corp\.?|Corporation|Co\.?|Ltd\.?|PLC|N\.?V\.?|S\.?A\.?|Group|Holdings|Holding)\b/gi, "")
    .replace(/[,.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const first = cleaned.split(/\s+/)[0];
  if (!first || first.length < 4) return null;
  if (!/^[A-Za-z]+$/.test(first)) return null;
  if (SHORT_ALIAS_DENYLIST.has(first.toLowerCase())) return null;
  return first;
}

async function main() {
  const { db } = await import("../lib/db");
  const { tickers, tickerAliases } = await import("../lib/db/schema");
  const { isNotNull, eq, and, sql, inArray } = await import("drizzle-orm");

  const rows = await db
    .select({ symbol: tickers.symbol, name: tickers.name })
    .from(tickers)
    .where(isNotNull(tickers.name));

  console.log(`[backfill] ${rows.length} tickers con nombre`);

  // 1) Purgar aliases ya guardados que ahora caen en denylist (limpieza)
  const allAliases = await db
    .select({ alias: tickerAliases.alias, symbol: tickerAliases.symbol })
    .from(tickerAliases);
  const toPurge: { alias: string; symbol: string }[] = [];
  for (const a of allAliases) {
    if (SHORT_ALIAS_DENYLIST.has(a.alias.toLowerCase())) {
      toPurge.push(a);
    }
  }
  console.log(`[backfill] purging ${toPurge.length} aliases genéricos`);
  for (const a of toPurge) {
    await db
      .delete(tickerAliases)
      .where(
        and(
          eq(tickerAliases.alias, a.alias),
          eq(tickerAliases.symbol, a.symbol),
        ),
      );
    console.log(`  - ${a.symbol} ✕ "${a.alias}"`);
  }

  // 2) Añadir aliases cortos faltantes
  let added = 0;
  for (const r of rows) {
    if (!r.name) continue;
    const alias = shortAlias(r.name);
    if (!alias) continue;
    if (alias.toUpperCase() === r.symbol) continue;
    const res = await db
      .insert(tickerAliases)
      .values({ alias, symbol: r.symbol })
      .onConflictDoNothing()
      .returning({ alias: tickerAliases.alias });
    if (res.length) {
      added++;
      if (added <= 30) console.log(`  + ${r.symbol} ← "${alias}"`);
    }
  }
  console.log(`\n[backfill] DONE: ${added} aliases añadidos, ${toPurge.length} purgados`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
