import { db } from "@/lib/db";
import { tickers, tickerAliases } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { getProfile } from "@/lib/providers/finnhub";

// Tickers nuevos llegan sin metadata. En cada cron procesamos hasta N de
// los más antiguos sin enriquecer (FIFO). Bajado a 12 desde 40 — cada
// llamada Finnhub tarda ~500ms-1s, 40 enrichments ≈ 20-40s blowing el
// 60s budget. 12×1s ≈ 12s deja oxígeno para el resto del pipeline.
const ENRICH_BATCH = 12;

export async function enrichPendingTickers(limit = ENRICH_BATCH) {
  // Solo NUNCA enriquecidos. Antes era "enrichedAt IS NULL OR logoUrl IS
  // NULL" pero eso creaba bucle infinito: Finnhub no tiene perfil para
  // muchos tickers (foreign, OTC), enricher seteaba enrichedAt pero dejaba
  // logoUrl=NULL → el OR lo re-cogía cada tick → loop eterno gastando
  // Finnhub rate-limit en tickers irreparables. Ahora una sola tentativa.
  const pending = await db
    .select({ symbol: tickers.symbol })
    .from(tickers)
    .where(sql`${tickers.enrichedAt} IS NULL`)
    .limit(limit);

  let done = 0;
  for (const { symbol } of pending) {
    const profile = await getProfile(symbol);
    const now = new Date();
    if (profile && profile.name) {
      await db
        .update(tickers)
        .set({
          name: profile.name,
          sector: profile.finnhubIndustry || null,
          industry: profile.finnhubIndustry || null,
          marketCap: profile.marketCapitalization
            ? Math.round(profile.marketCapitalization * 1_000_000)
            : null,
          logoUrl: profile.logo || null,
          enrichedAt: now,
        })
        .where(eq(tickers.symbol, symbol));

      // Crear alias automático para futuras detecciones por nombre.
      const aliasCandidates = uniqueAliases(profile.name);
      for (const alias of aliasCandidates) {
        await db
          .insert(tickerAliases)
          .values({ alias, symbol })
          .onConflictDoNothing();
      }
      done++;
    } else {
      // Marcamos como enriquecido aunque sea sin datos para no reintentar.
      await db
        .update(tickers)
        .set({ enrichedAt: now })
        .where(eq(tickers.symbol, symbol));
    }
  }
  return { processed: pending.length, succeeded: done };
}

// Palabras inglesas comunes que NO sirven como alias corto de ticker.
// Si la primera palabra del nombre cae aquí, no la añadimos sola (riesgo de
// matchear noticias irrelevantes — ej. "American" matchearía todo). El alias
// largo sigue funcionando para detectar el ticker.
const SHORT_ALIAS_DENYLIST = new Set([
  // Geográficos / cualificadores
  "american", "united", "national", "general", "first", "federal",
  "international", "global", "world", "new", "northern", "southern",
  "eastern", "western", "central", "atlantic", "pacific", "continental",
  // Sectoriales / corporativos
  "bank", "banc", "banco", "financial", "trust", "capital", "credit",
  "energy", "industries", "industrial", "networks", "media", "health",
  "tech", "technologies", "technology", "data", "systems", "services",
  "holdings", "holding", "group", "company", "corporation",
  "real", "estate", "advanced", "applied", "alpha", "beta", "core",
  // Calificativos
  "good", "great", "best", "big", "major", "premier", "prime", "pure",
  // Nombres propios comunes
  "charles", "robert", "james", "william", "thomas", "henry", "george",
  "walt", "morgan", "wells",
  // Verbos / sustantivos genéricos que aparecen masivamente en headlines
  "home", "trade", "block", "delta", "twist", "rise", "fall", "fly",
  "build", "hold", "buy", "sell", "make", "take", "give", "work",
  "live", "save", "lead", "join", "move", "stop", "start", "open",
  "close", "ride", "share", "store", "store", "stock", "stocks",
  "market", "future", "ramp", "boost", "spark", "watch", "winner",
  // 2026-05: tras audit. Aliases que el enricher generaba "primera palabra"
  // pero matcheaban palabras comunes en headlines genéricos.
  "performance", "canadian", "growth", "earnings", "revenue",
  "shares", "price", "value", "report", "rating", "quarter",
  "fiscal", "annual", "guidance",
  // Sufijos corporativos
  "target", "sea", "co", "corp", "inc", "ltd", "plc",
]);

function uniqueAliases(name: string): string[] {
  const aliases = new Set<string>();
  const cleaned = name
    .replace(/\b(Inc\.?|Corp\.?|Corporation|Co\.?|Ltd\.?|PLC|N\.?V\.?|S\.?A\.?|Group|Holdings|Holding)\b/gi, "")
    .replace(/[,.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 3) aliases.add(cleaned);
  if (name.trim().length >= 3 && name.trim() !== cleaned) {
    aliases.add(name.trim());
  }
  // Alias corto (primera palabra) — captura headlines tipo "Dell soared 14%"
  // o "Apple beats". v3.2 solo guardaba "Dell Technologies" → 0 matches.
  // Restricciones:
  //   - ≥4 chars (Dell, Apple, Tesla, Nvidia; rechaza Co, Inc, BP)
  //   - alpha-only (no números, no símbolos)
  //   - no en denylist de palabras comunes
  const firstWord = cleaned.split(/\s+/)[0];
  if (
    firstWord &&
    firstWord.length >= 4 &&
    /^[A-Za-z]+$/.test(firstWord) &&
    !SHORT_ALIAS_DENYLIST.has(firstWord.toLowerCase())
  ) {
    aliases.add(firstWord);
  }
  return Array.from(aliases);
}
