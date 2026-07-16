import { db } from "@/lib/db";
import { tickers, tickerAliases } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { getProfile } from "@/lib/providers/finnhub";
import { COMMON_WORD_DENYLIST } from "./alias-denylist";

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

  // Workers paralelos (audit 2026-05-12 #4): antes el for-loop secuencial
  // hacía 12 × (~500ms Finnhub + UPDATE + N alias INSERTs) ≈ 12-25s. Con
  // concurrency=4 quedamos en ~3-7s. Finnhub free = 60 RPM compartido con
  // refresh-news (~10/min) + /api/quotes polling (~20/min) — 4 concurrentes
  // aquí (~12/min en burst) deja ~18/min de holgura.
  const CONCURRENCY = 4;
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= pending.length) return;
      const { symbol } = pending[i];
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
        // Batched insert: un solo round-trip por ticker (vs N antes).
        const aliasCandidates = uniqueAliases(profile.name);
        if (aliasCandidates.length) {
          await db
            .insert(tickerAliases)
            .values(aliasCandidates.map((alias) => ({ alias, symbol })))
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
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker()),
  );
  return { processed: pending.length, succeeded: done };
}

// Palabras inglesas comunes que NO sirven como alias corto de ticker.
// Si la primera palabra del nombre cae aquí, no la añadimos sola (riesgo de
// matchear noticias irrelevantes — ej. "American" matchearía todo). El alias
// largo sigue funcionando para detectar el ticker.
// 2026-07-15: unificada con la del extractor en lib/tickers/alias-denylist.ts
// — mantener dos listas divergentes fue lo que dejó pasar "Research"→RSSS,
// "Under"→UAA, "Trump"→DJT y compañía.
const SHORT_ALIAS_DENYLIST = COMMON_WORD_DENYLIST;

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
