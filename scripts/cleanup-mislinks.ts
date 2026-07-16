import { config } from "dotenv";
config({ path: ".env.local" });

// One-time cleanup 2026-07-15 (audit mislinks):
//   1. "Blackrock" apuntaba a BKT (BlackRock Income Trust) — lo correcto es
//      BLK (BlackRock Inc). Reasignamos el alias.
//   2. Borra aliases de una palabra que son palabras comunes (denylist
//      compartida nueva) — "Research"→RSSS, "Trump"→DJT, "Under"→UAA, etc.
//   3. Re-valida los links dict de los símbolos afectados: si con los
//      aliases restantes el símbolo ya no se extrae del texto, el link era
//      producto del alias basura → se borra.
//   4. Re-valida los links api de gnews: si el texto no menciona al ticker
//      (mentionsTicker), el link era matching laxo de Google → se borra.
//
// Uso: pnpm exec tsx scripts/cleanup-mislinks.ts [--dry-run]

const DRY = process.argv.includes("--dry-run");

async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");
  const { COMMON_WORD_DENYLIST } = await import("../lib/tickers/alias-denylist");
  const { mentionsTicker } = await import("../lib/providers/google-news-tickers");

  const exec = (s: ReturnType<typeof sql>) =>
    db.execute(s) as unknown as Promise<{ rowCount?: number; rows?: unknown[] }>;

  // --- 1. Blackrock → BLK -------------------------------------------------
  await exec(sql`INSERT INTO tickers (symbol, source) VALUES ('BLK', 'cleanup') ON CONFLICT DO NOTHING`);
  if (!DRY) {
    const r = await exec(sql`
      UPDATE ticker_aliases SET symbol = 'BLK'
      WHERE lower(alias) = 'blackrock' AND symbol <> 'BLK'
    `);
    console.log(`[1] blackrock alias reassigned to BLK: ${r.rowCount ?? 0}`);
  }

  // --- 2. Borrar aliases basura -------------------------------------------
  // NB: drizzle expande arrays JS a tuplas "($1,$2,…)" — usar IN, no ANY().
  const junkWords = Array.from(COMMON_WORD_DENYLIST);
  const junk = unwrapRows<{ alias: string; symbol: string }>(
    await exec(sql`
      SELECT alias, symbol FROM ticker_aliases
      WHERE alias NOT LIKE '% %' AND lower(alias) IN ${junkWords}
    `),
  );
  console.log(`[2] junk single-word aliases found: ${junk.length}`);
  for (const j of junk) console.log(`    "${j.alias}" → ${j.symbol}`);
  const affectedSymbols = Array.from(new Set(junk.map((j) => j.symbol)));
  if (!DRY && junk.length) {
    const r = await exec(sql`
      DELETE FROM ticker_aliases
      WHERE alias NOT LIKE '% %' AND lower(alias) IN ${junkWords}
    `);
    console.log(`[2] deleted: ${r.rowCount ?? 0}`);
  }

  // --- 3. Re-validar links dict de símbolos afectados ----------------------
  // Réplica de las reglas del extractor para matching por diccionario:
  // alias ≥3 chars, denylist skip, ≤4 chars case-sensitive, ≥5 insensitive.
  const remaining = affectedSymbols.length
    ? unwrapRows<{ alias: string; symbol: string }>(
        await exec(
          sql`SELECT alias, symbol FROM ticker_aliases WHERE symbol IN ${affectedSymbols}`,
        ),
      )
    : [];
  const aliasesBySymbol = new Map<string, string[]>();
  for (const a of remaining) {
    if (a.alias.length < 3) continue;
    if (COMMON_WORD_DENYLIST.has(a.alias.toLowerCase())) continue;
    const list = aliasesBySymbol.get(a.symbol) ?? [];
    list.push(a.alias);
    aliasesBySymbol.set(a.symbol, list);
  }
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stillMatches = (haystack: string, symbol: string): boolean => {
    const sym = symbol.toUpperCase();
    // Señales explícitas: $SYM, (SYM), (EXCH:SYM)
    if (new RegExp(`\\$${escapeRe(sym)}\\b`).test(haystack)) return true;
    if (new RegExp(`\\((?:[A-Z]+:)?${escapeRe(sym)}\\)`).test(haystack)) return true;
    for (const alias of aliasesBySymbol.get(symbol) ?? []) {
      const flags = alias.length <= 4 ? "" : "i";
      if (new RegExp(`\\b${escapeRe(alias)}\\b`, flags).test(haystack)) return true;
    }
    return false;
  };

  const dictLinks = affectedSymbols.length
    ? unwrapRows<{
        news_id: number;
        ticker: string;
        headline: string;
        body: string | null;
      }>(
        await exec(sql`
          SELECT nt.news_id, nt.ticker, n.headline, n.body
          FROM news_tickers nt JOIN news n ON n.id = nt.news_id
          WHERE nt.extraction_method = 'dict' AND nt.ticker IN ${affectedSymbols}
        `),
      )
    : [];
  const dictToDelete = dictLinks.filter(
    (l) => !stillMatches(`${l.headline}\n${l.body ?? ""}`, l.ticker),
  );
  console.log(
    `[3] dict links on affected symbols: ${dictLinks.length}, invalid: ${dictToDelete.length}`,
  );

  // --- 4. Re-validar links api de gnews ------------------------------------
  const gnewsLinks = unwrapRows<{
    news_id: number;
    ticker: string;
    headline: string;
    body: string | null;
    name: string | null;
  }>(
    await exec(sql`
      SELECT nt.news_id, nt.ticker, n.headline, n.body, t.name
      FROM news_tickers nt
      JOIN news n ON n.id = nt.news_id
      LEFT JOIN tickers t ON t.symbol = nt.ticker
      WHERE nt.extraction_method = 'api' AND n.source LIKE 'gnews:%'
    `),
  );
  const gnewsToDelete = gnewsLinks.filter(
    (l) => !mentionsTicker(`${l.headline}\n${l.body ?? ""}`, l.ticker, l.name),
  );
  console.log(
    `[4] gnews api links: ${gnewsLinks.length}, invalid: ${gnewsToDelete.length}`,
  );

  // --- Borrado por lotes ----------------------------------------------------
  const toDelete = [
    ...dictToDelete.map((l) => ({ id: l.news_id, ticker: l.ticker, method: "dict" })),
    ...gnewsToDelete.map((l) => ({ id: l.news_id, ticker: l.ticker, method: "api" })),
  ];
  if (DRY) {
    console.log(`[dry-run] would delete ${toDelete.length} links`);
    for (const d of toDelete.slice(0, 30)) console.log(`    ${d.ticker} news=${d.id} (${d.method})`);
    return;
  }
  // Agrupamos por ticker: DELETE ... WHERE ticker = X AND news_id IN (...).
  const idsByTicker = new Map<string, number[]>();
  for (const d of toDelete) {
    const list = idsByTicker.get(d.ticker) ?? [];
    list.push(d.id);
    idsByTicker.set(d.ticker, list);
  }
  let deleted = 0;
  const CHUNK = 500;
  for (const [ticker, ids] of idsByTicker) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const r = await exec(sql`
        DELETE FROM news_tickers
        WHERE ticker = ${ticker} AND news_id IN ${chunk}
      `);
      deleted += r.rowCount ?? 0;
    }
  }
  console.log(`[done] deleted ${deleted} bad links`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
