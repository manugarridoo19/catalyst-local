// Surgical: borra alias bare "Sterling" (STRL) y "Block" (XYZ) que están
// causando mislinks contra GBP currency y "block deal" jerga financiera.
// Añade "Block Inc" como alias para XYZ (ticker fue renombrado de SQ).
// Purga news_tickers mislinkeados.
//
//   pnpm tsx scripts/purge-sterling-block.ts [--dry]

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { sql, inArray, and, eq } from "drizzle-orm";

async function main() {
  const DRY = process.argv.includes("--dry");
  if (DRY) console.log("[purge] DRY RUN\n");

  const { db } = await import("../lib/db");
  const { tickerAliases, newsTickers } = await import("../lib/db/schema");

  // 1) Borrar el alias bare "Sterling" (deja "Sterling Infrastructure" intacto).
  if (!DRY) {
    const d1 = await db.execute(sql`
      DELETE FROM ticker_aliases WHERE symbol = 'STRL' AND alias = 'Sterling' RETURNING alias
    `);
    const r1 = ((d1 as { rows?: unknown[] }).rows ?? (d1 as unknown as unknown[]));
    console.log(`[purge] dropped STRL alias 'Sterling': ${r1.length} row(s)`);
  } else {
    console.log("[purge] would drop STRL alias 'Sterling'");
  }

  // 2) Borrar el alias bare "Block" de XYZ.
  if (!DRY) {
    const d2 = await db.execute(sql`
      DELETE FROM ticker_aliases WHERE symbol = 'XYZ' AND alias = 'Block' RETURNING alias
    `);
    const r2 = ((d2 as { rows?: unknown[] }).rows ?? (d2 as unknown as unknown[]));
    console.log(`[purge] dropped XYZ alias 'Block': ${r2.length} row(s)`);
  } else {
    console.log("[purge] would drop XYZ alias 'Block'");
  }

  // 3) Añadir "Block Inc" como alias para XYZ (ticker renombrado de SQ Aug 2025).
  if (!DRY) {
    const ins = await db.insert(tickerAliases)
      .values({ alias: "Block Inc", symbol: "XYZ" })
      .onConflictDoNothing()
      .returning({ alias: tickerAliases.alias });
    console.log(`[purge] added XYZ alias 'Block Inc': ${ins.length} row(s)`);
  } else {
    console.log("[purge] would add XYZ alias 'Block Inc'");
  }

  // 4) Purgar news_tickers donde STRL está linkeado a noticia con "sterling"
  //    minúscula PERO sin "Sterling Infrastructure" (las legítimas se quedan).
  const strlBad = await db.execute(sql`
    SELECT n.id, n.headline
    FROM news n
    JOIN news_tickers nt ON nt.news_id = n.id
    WHERE nt.ticker = 'STRL'
      AND n.headline ILIKE '%sterling%'
      AND n.headline NOT ILIKE '%Sterling Infrastructure%'
      AND n.headline NOT ILIKE '%(STRL)%'
      AND n.headline NOT ILIKE '%STRL%'
  `);
  const strlBadRows = ((strlBad as { rows?: Array<{ id: number; headline: string }> }).rows
    ?? (strlBad as unknown as Array<{ id: number; headline: string }>));
  console.log(`\n[purge] STRL mislinks to purge: ${strlBadRows.length}`);
  for (const r of strlBadRows.slice(0, 10)) {
    console.log(`  news#${r.id}: ${r.headline.slice(0, 90)}`);
  }

  if (!DRY && strlBadRows.length) {
    const ids = strlBadRows.map(r => r.id);
    const d = await db.delete(newsTickers)
      .where(and(eq(newsTickers.ticker, "STRL"), inArray(newsTickers.newsId, ids)))
      .returning({ id: newsTickers.newsId });
    console.log(`[purge] STRL mislinks deleted: ${d.length}`);
  }

  // 5) Purgar XYZ links a "block deal/trade" cuando el headline NO tiene "Block Inc" ni "(XYZ)".
  const xyzBad = await db.execute(sql`
    SELECT n.id, n.headline
    FROM news n
    JOIN news_tickers nt ON nt.news_id = n.id
    WHERE nt.ticker = 'XYZ'
      AND (n.headline ILIKE '%block deal%' OR n.headline ILIKE '%block trade%')
      AND n.headline NOT ILIKE '%Block Inc%'
      AND n.headline NOT ILIKE '%(XYZ)%'
      AND n.headline NOT ILIKE '%XYZ%'
  `);
  const xyzBadRows = ((xyzBad as { rows?: Array<{ id: number; headline: string }> }).rows
    ?? (xyzBad as unknown as Array<{ id: number; headline: string }>));
  console.log(`\n[purge] XYZ block-deal mislinks to purge: ${xyzBadRows.length}`);
  for (const r of xyzBadRows.slice(0, 5)) {
    console.log(`  news#${r.id}: ${r.headline.slice(0, 90)}`);
  }

  if (!DRY && xyzBadRows.length) {
    const ids = xyzBadRows.map(r => r.id);
    const d = await db.delete(newsTickers)
      .where(and(eq(newsTickers.ticker, "XYZ"), inArray(newsTickers.newsId, ids)))
      .returning({ id: newsTickers.newsId });
    console.log(`[purge] XYZ mislinks deleted: ${d.length}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
