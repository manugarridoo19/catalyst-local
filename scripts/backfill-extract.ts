// One-shot: re-aplica el extractor de tickers sobre TODAS las noticias
// existentes que aún no tienen ticker asociado. Útil tras seed-major.
//
//   pnpm tsx scripts/backfill-extract.ts

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { news, newsTickers, tickers } = await import("../lib/db/schema");
  const { sql } = await import("drizzle-orm");
  const { extractTickers } = await import("../lib/tickers/extractor");
  const { loadAliases, loadKnownSymbols, upsertTickers } = await import("../lib/db/queries");

  // Cargar aliases + known symbols (para leading-ticker regex).
  const [aliases, knownSymbols] = await Promise.all([
    loadAliases(),
    loadKnownSymbols(),
  ]);
  console.log(`[backfill-extract] ${aliases.length} aliases + ${knownSymbols.size} known symbols loaded`);

  // Noticias sin ningún ticker asociado.
  const orphaned = await db.execute(sql`
    SELECT id, headline, body, source
    FROM news
    WHERE id NOT IN (SELECT news_id FROM news_tickers)
    ORDER BY published_at DESC
    LIMIT 5000
  `);

  const rows = unwrapRows<{
    id: number;
    headline: string;
    body: string | null;
    source: string;
  }>(orphaned);
  console.log(`[backfill-extract] ${rows.length} orphaned news to process`);

  let totalTagged = 0;
  let newsWithTickers = 0;

  for (const r of rows) {
    const item = {
      url: "",
      hash: "",
      headline: r.headline,
      source: r.source,
      publishedAt: new Date(),
      body: r.body ?? undefined,
      apiTickers: [],
    };
    const extracted = extractTickers(item, aliases, { knownSymbols });
    if (extracted.length === 0) continue;

    // Asegurar que los tickers existen.
    await upsertTickers(extracted.map((e) => e.symbol), "backfill-extract");

    // Insertar las relaciones news_tickers.
    await db
      .insert(newsTickers)
      .values(
        extracted.map((t) => ({
          newsId: r.id,
          ticker: t.symbol,
          extractionMethod: t.method,
        })),
      )
      .onConflictDoNothing();

    totalTagged += extracted.length;
    newsWithTickers++;
    if (newsWithTickers % 100 === 0) {
      console.log(
        `[backfill-extract] progress: ${newsWithTickers} news tagged (${totalTagged} ticker links)`,
      );
    }
  }

  console.log(
    `[backfill-extract] done: ${newsWithTickers}/${rows.length} news got tickers (${totalTagged} total links)`,
  );

  // Verificar el rate de cobertura final.
  const finalStats = await db.execute(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE id IN (SELECT news_id FROM news_tickers)) AS tagged
    FROM news
  `);
  console.log("[backfill-extract] coverage:", unwrapRows<{ total: string; tagged: string }>(finalStats));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
