// One-shot: re-extrae tickers en noticias que matchean el pattern de acción
// analítica ("JPMorgan raises X target", etc.). El extractor ahora suprime
// los tickers del banco — re-aplicarlo elimina los links falsos. También
// borra news_scores afectados para que el cron rescore con el ticker correcto.
//
//   pnpm tsx scripts/backfill-analyst-suppress.ts

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const DRY = process.argv.includes("--dry");
  if (DRY) console.log("[backfill-analyst] DRY RUN — no DB writes\n");

  const { db } = await import("../lib/db");
  const { newsTickers, newsScores } = await import("../lib/db/schema");
  const { sql, eq } = await import("drizzle-orm");
  const { extractTickers } = await import("../lib/tickers/extractor");
  const { loadAliases, loadKnownSymbols, upsertTickers } = await import("../lib/db/queries");

  const [aliases, knownSymbols] = await Promise.all([
    loadAliases(),
    loadKnownSymbols(),
  ]);
  console.log(`[backfill-analyst] ${aliases.length} aliases + ${knownSymbols.size} known symbols`);

  // Patrón: headline empieza con firma analítica seguida de verbo de acción.
  // Hacemos un primer filtro amplio en SQL para no traer todo a memoria.
  const BANK_PREFIXES = [
    "JPMorgan", "JP Morgan", "J.P. Morgan", "Morgan Stanley",
    "Goldman Sachs", "Goldman", "Bank of America", "BofA", "Merrill Lynch",
    "Wells Fargo", "Citi", "Citigroup", "Barclays", "UBS", "Deutsche Bank",
    "HSBC", "RBC", "BMO", "Mizuho", "Stifel", "Piper Sandler", "Jefferies",
    "Truist", "Wedbush", "Raymond James", "Oppenheimer", "KBW", "BTIG",
    "Cantor Fitzgerald", "Cantor", "Needham", "Baird", "Evercore",
    "Macquarie", "Credit Suisse",
  ];
  const VERBS = [
    "raises", "raise", "cuts", "cut", "maintains", "maintain",
    "reiterates", "reiterate", "upgrades", "upgrade", "downgrades", "downgrade",
    "initiates", "initiate", "lifts", "lift", "lowers", "lower",
    "reaffirms", "reaffirm", "trims", "trim", "boosts", "boost",
    "drops", "drop", "hikes", "hike", "increases", "increase",
    "decreases", "decrease", "starts", "start", "begins", "begin",
    "says", "calls", "names", "rates",
  ];

  // Filtro amplio con ILIKE (Postgres ~* no soporta \s\b igual que JS).
  // El extractor en JS hace la decisión final con regex preciso — aquí
  // solo necesitamos un primer cribado que cubra todas las combinaciones.
  const prefixClauses = BANK_PREFIXES.map(b => `headline ILIKE '${b.replace(/'/g, "''")} %'`).join(" OR ");
  const verbClauses = VERBS.map(v => `headline ILIKE '% ${v} %'`).join(" OR ");
  const result = await db.execute(sql.raw(`
    SELECT id, headline, body, source
    FROM news
    WHERE (${prefixClauses})
      AND (${verbClauses})
    ORDER BY published_at DESC
  `));
  const rows = ((result as { rows?: Array<Record<string, unknown>> }).rows
    ?? (result as unknown as Array<Record<string, unknown>>)) as Array<{
      id: number; headline: string; body: string | null; source: string;
    }>;
  console.log(`[backfill-analyst] ${rows.length} news matching analyst-action pattern`);

  let updated = 0;
  let scoresDropped = 0;
  let beforeTotal = 0;
  let afterTotal = 0;

  for (const r of rows) {
    // Tickers actuales linkeados.
    const cur = await db.execute(sql`
      SELECT ticker FROM news_tickers WHERE news_id = ${r.id}
    `);
    const curRows = ((cur as { rows?: Array<{ ticker: string }> }).rows
      ?? (cur as unknown as Array<{ ticker: string }>)) as Array<{ ticker: string }>;
    const curTickers = curRows.map(x => x.ticker).sort();
    beforeTotal += curTickers.length;

    // Re-extracción con extractor actualizado.
    const item = {
      sourceId: "",
      url: "",
      hash: "",
      headline: r.headline,
      sourceName: r.source,
      publishedAt: new Date(),
      body: r.body ?? "",
      apiTickers: [],
    };
    const extracted = extractTickers(item, aliases, { knownSymbols });
    const newTickers = extracted.map(e => e.symbol).sort();
    afterTotal += newTickers.length;

    // Solo actualizar si cambia el set.
    const same = curTickers.length === newTickers.length
      && curTickers.every((t, i) => t === newTickers[i]);
    if (same) continue;

    // Reemplazar links (skipped in dry-run).
    if (!DRY) {
      if (newTickers.length) {
        await upsertTickers(newTickers, "backfill-analyst-suppress");
      }
      await db.delete(newsTickers).where(eq(newsTickers.newsId, r.id));
      if (extracted.length) {
        await db.insert(newsTickers)
          .values(extracted.map(t => ({
            newsId: r.id, ticker: t.symbol, extractionMethod: t.method,
          })))
          .onConflictDoNothing();
      }
      // Invalidar score — cron lo rescoreará con el ticker correcto.
      const del = await db.delete(newsScores).where(eq(newsScores.newsId, r.id)).returning({ id: newsScores.newsId });
      if (del.length) scoresDropped++;
    } else {
      // In dry-run, check whether score would be dropped.
      const cur = await db.execute(sql`SELECT 1 FROM news_scores WHERE news_id = ${r.id}`);
      const curRows2 = ((cur as { rows?: unknown[] }).rows ?? (cur as unknown as unknown[])) as unknown[];
      if (curRows2.length) scoresDropped++;
    }

    updated++;
    if (updated <= 20 || updated % 100 === 0) {
      console.log(`  [${updated}] news#${r.id}`);
      console.log(`    headline: ${r.headline.slice(0, 90)}`);
      console.log(`    before:   [${curTickers.join(",")}]`);
      console.log(`    after:    [${newTickers.join(",")}]`);
    }
  }

  console.log(`\n[backfill-analyst] done:`);
  console.log(`  news scanned:     ${rows.length}`);
  console.log(`  news updated:     ${updated}`);
  console.log(`  scores dropped:   ${scoresDropped} (cron rescoreará)`);
  console.log(`  links before:     ${beforeTotal}`);
  console.log(`  links after:      ${afterTotal}`);
  console.log(`  net links removed:${beforeTotal - afterTotal}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
