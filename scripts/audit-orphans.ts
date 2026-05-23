// Diagnostic: agrupa news SIN ticker por (a) fuente, (b) primeras palabras
// del headline. Útil para identificar:
//   - Fuentes que necesitan filtros (mucho macro/sector → tirar a /news tab).
//   - Company names que aparecen seguido pero el extractor no captura
//     (candidatos a añadir al alias dict via scripts/seed-aliases.ts).
//
//   pnpm tsx scripts/audit-orphans.ts          # default 30 días
//   pnpm tsx scripts/audit-orphans.ts --days=7 # solo últimos 7

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const DAYS_ARG = process.argv.find((a) => a.startsWith("--days="));
const DAYS = DAYS_ARG ? Math.max(1, parseInt(DAYS_ARG.split("=")[1] ?? "30", 10) || 30) : 30;

async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  console.log(`[audit-orphans] window: last ${DAYS} days\n`);

  // 1) Top sources con más orphans (absoluto + relativo).
  const bySource = unwrapRows<{
    source: string;
    orphans: number;
    total: number;
    pct: string;
  }>(
    await db.execute(sql`
      WITH base AS (
        SELECT n.source, n.id,
          EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id) AS has_ticker
        FROM news n
        WHERE n.published_at >= now() - (${DAYS}::int * interval '1 day')
      )
      SELECT source,
        COUNT(*) FILTER (WHERE NOT has_ticker)::int AS orphans,
        COUNT(*)::int AS total,
        ROUND(100.0 * COUNT(*) FILTER (WHERE NOT has_ticker) / NULLIF(COUNT(*), 0), 1)::text AS pct
      FROM base
      GROUP BY source
      HAVING COUNT(*) FILTER (WHERE NOT has_ticker) >= 5
      ORDER BY orphans DESC
      LIMIT 25
    `),
  );

  console.log(`=== Top sources by orphan count (≥5 orphans, last ${DAYS}d) ===`);
  console.log("source                          orphans  total   orphan%");
  console.log("-".repeat(60));
  for (const r of bySource) {
    console.log(
      `${r.source.padEnd(32)} ${String(r.orphans).padStart(6)}  ${String(r.total).padStart(5)}   ${r.pct.padStart(5)}%`,
    );
  }

  // 2) Bigrams iniciales (primeras 2 palabras minus stopwords) que se repiten
  // en headlines orphan. Heurística para detectar company names recurrentes
  // que NO están en el alias dict.
  const STOPWORDS = new Set([
    "the", "a", "an", "this", "that", "these", "those",
    "to", "of", "in", "on", "at", "by", "for", "with", "from",
    "is", "are", "was", "were", "be", "been", "being",
    "as", "and", "or", "but", "not", "no",
    "will", "shall", "may", "can", "could", "should", "would",
    "us", "we", "you", "they", "i",
    "more", "less", "new", "old", "next", "last", "first",
    "report", "reports", "says", "said", "stocks", "stock", "market", "markets",
    "earnings", "revenue", "guidance", "shares", "today", "yesterday",
    "after", "before", "amid", "ahead", "during",
    "how", "why", "what", "when", "where", "which",
  ]);

  const orphansRaw = unwrapRows<{ headline: string }>(
    await db.execute(sql`
      SELECT n.headline
      FROM news n
      WHERE n.published_at >= now() - (${DAYS}::int * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
      LIMIT 5000
    `),
  );

  const bigramCount = new Map<string, number>();
  for (const r of orphansRaw) {
    // Tomar las primeras 4 "palabras significativas" del headline.
    const words = r.headline
      .replace(/[^A-Za-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const significant: string[] = [];
    for (const w of words) {
      const low = w.toLowerCase();
      // Mantener Capitalized o ALL-CAPS o números; descartar stopwords.
      const isCap = /^[A-Z]/.test(w);
      const isAllCap = w === w.toUpperCase() && /[A-Z]/.test(w);
      if (!isCap && !isAllCap) continue;
      if (STOPWORDS.has(low)) continue;
      significant.push(w);
      if (significant.length >= 4) break;
    }
    // Bigramas adyacentes de las primeras 4 capitalized.
    for (let i = 0; i + 1 < significant.length; i++) {
      const bg = `${significant[i]} ${significant[i + 1]}`;
      bigramCount.set(bg, (bigramCount.get(bg) ?? 0) + 1);
    }
    // También las unigramas significativas (single word company names tipo "Tesla").
    for (const w of significant) {
      if (w.length >= 4) {
        bigramCount.set(w, (bigramCount.get(w) ?? 0) + 1);
      }
    }
  }

  const top = [...bigramCount.entries()]
    .filter(([, n]) => n >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);

  console.log(`\n=== Top capitalized ngrams in orphans (≥5 occurrences, ${orphansRaw.length} headlines) ===`);
  console.log("count  ngram (candidate alias?)");
  console.log("-".repeat(50));
  for (const [bg, n] of top) {
    console.log(`${String(n).padStart(5)}  ${bg}`);
  }

  console.log(`\n[audit-orphans] tip: cross-reference top ngrams with your alias dict.`);
  console.log(`[audit-orphans] valid company names → add to scripts/seed-aliases.ts list.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
