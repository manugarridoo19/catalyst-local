// One-shot: re-aplica el extractor de tickers sobre TODAS las noticias
// existentes que aún no tienen ticker asociado. Útil tras seed-major.
//
//   pnpm tsx scripts/backfill-extract.ts                  # 5000 default
//   pnpm tsx scripts/backfill-extract.ts --limit=10000    # 10k en un run
//   pnpm tsx scripts/backfill-extract.ts --broadcast      # + Pusher updates
//
// Con `--broadcast` emite un FeedNewsPayload por noticia retroactivamente
// taggeada (audit 2026-05-12 #11) — el cliente del feed live actualiza
// el card in-place gracias al match por id, y los ticker pages reciben
// la noticia en tiempo real sin esperar al próximo SSR.
//
// --limit cap: 50000 para no quedarse sin RAM con el array de payloads.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const BROADCAST = process.argv.includes("--broadcast");
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG
  ? Math.min(50_000, Math.max(1, parseInt(LIMIT_ARG.split("=")[1] ?? "5000", 10) || 5000))
  : 5000;

async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { newsTickers } = await import("../lib/db/schema");
  const { sql } = await import("drizzle-orm");
  const { extractTickers } = await import("../lib/tickers/extractor");
  const {
    loadAliases,
    loadKnownSymbols,
    upsertTickers,
    getTickerMetaMap,
  } = await import("../lib/db/queries");
  const { broadcastNews } = await import("../lib/pusher/server");
  type Payload = import("../lib/pusher/server").FeedNewsPayload;

  // Cargar aliases + known symbols (para leading-ticker regex).
  const [aliases, knownSymbols] = await Promise.all([
    loadAliases(),
    loadKnownSymbols(),
  ]);
  console.log(`[backfill-extract] ${aliases.length} aliases + ${knownSymbols.size} known symbols loaded`);

  // Noticias sin ningún ticker asociado. SELECT extendido para construir
  // payloads de broadcast sin segunda query — published_at + url + body
  // ya están en la fila.
  const orphaned = await db.execute(sql`
    SELECT n.id, n.headline, n.body, n.source, n.published_at, n.url,
      s.impact, s.sentiment, s.rationale
    FROM news n
    LEFT JOIN news_scores s ON s.news_id = n.id
    WHERE n.id NOT IN (SELECT news_id FROM news_tickers)
    ORDER BY n.published_at DESC
    LIMIT ${LIMIT}
  `);

  const rows = unwrapRows<{
    id: number;
    headline: string;
    body: string | null;
    source: string;
    published_at: Date;
    url: string;
    impact: number | null;
    sentiment: number | null;
    rationale: string | null;
  }>(orphaned);
  console.log(`[backfill-extract] ${rows.length} orphaned news to process (limit=${LIMIT}${BROADCAST ? ", broadcast=ON" : ""})`);

  let totalTagged = 0;
  let newsWithTickers = 0;
  const broadcastQueue: Payload[] = [];

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

    if (BROADCAST) {
      broadcastQueue.push({
        id: r.id,
        headline: r.headline,
        body: r.body,
        source: r.source,
        publishedAt: new Date(r.published_at).toISOString(),
        url: r.url,
        tickers: extracted.map((t) => t.symbol),
        primarySymbol: extracted[0]?.symbol ?? null,
        impact: r.impact,
        sentiment: r.sentiment,
        rationale: r.rationale,
      });
    }

    if (newsWithTickers % 100 === 0) {
      console.log(
        `[backfill-extract] progress: ${newsWithTickers} news tagged (${totalTagged} ticker links)`,
      );
    }
  }

  console.log(
    `[backfill-extract] done: ${newsWithTickers}/${rows.length} news got tickers (${totalTagged} total links)`,
  );

  // Broadcast en batches. Pusher acepta 10 events por trigger, broadcastNews
  // ya hace el chunking; enriquecemos antes con logo+nombre del primary.
  if (BROADCAST && broadcastQueue.length) {
    console.log(`[backfill-extract] broadcasting ${broadcastQueue.length} retroactive payloads…`);
    const primarySymbols = broadcastQueue
      .map((b) => b.primarySymbol)
      .filter((s): s is string => Boolean(s));
    const meta = await getTickerMetaMap(primarySymbols);
    for (const b of broadcastQueue) {
      if (b.primarySymbol) {
        const m = meta.get(b.primarySymbol);
        b.primaryName = m?.name ?? null;
        b.primaryLogo = m?.logoUrl ?? null;
      }
    }
    // Chunked manualmente para dar visibilidad de progreso y no saturar
    // Pusher si la cola es grande (5000 items posibles).
    const CHUNK = 50;
    for (let i = 0; i < broadcastQueue.length; i += CHUNK) {
      await broadcastNews(broadcastQueue.slice(i, i + CHUNK));
      if (i + CHUNK < broadcastQueue.length) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    console.log(`[backfill-extract] broadcast complete.`);
  }

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
