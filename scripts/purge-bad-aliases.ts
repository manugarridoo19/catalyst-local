// Limpia falsos positivos del extractor antiguo + drops bad aliases.
// Idempotente — safe correr múltiples veces.
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const BAD_ALIASES = [
  "Sea", "Target", "Group", "Capital", "Bank", "Energy",
  "Industries", "Networks", "Real", "Trust", "Media",
  "Health", "Tech", "Data", "Holdings", "International",
  "Global", "Company",
];

// Tickers que solo deben venir vía API (1-2 chars o palabras comunes).
// Para estos borramos rows news_tickers extraídas por dict/regex.
const API_ONLY = [
  "A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q",
  "R","S","T","U","V","W","X","Y","Z",
  "MS","SE","AI","UP","ON","GO","RH","DG","EA","BJ","TGT",
];

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  console.log("=== before ===");
  const before = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM news_tickers WHERE ticker = ANY(ARRAY[${sql.raw(API_ONLY.map((s) => `'${s}'`).join(","))}]::text[]) AND extraction_method = 'dict'
  `);
  console.log("dict-method rows for API-only tickers:", (before.rows ?? before)[0]);

  console.log("\n=== dropping bad aliases ===");
  const dropAliases = await db.execute(sql`
    DELETE FROM ticker_aliases WHERE alias = ANY(ARRAY[${sql.raw(BAD_ALIASES.map((s) => `'${s}'`).join(","))}]::text[]) RETURNING alias, symbol
  `);
  for (const r of (dropAliases.rows ?? dropAliases) as any[]) {
    console.log(`  drop  ${r.alias.padEnd(15)} → ${r.symbol}`);
  }

  console.log("\n=== purging news_tickers dict rows for API-only tickers ===");
  const purged = await db.execute(sql`
    DELETE FROM news_tickers
    WHERE ticker = ANY(ARRAY[${sql.raw(API_ONLY.map((s) => `'${s}'`).join(","))}]::text[])
      AND extraction_method = 'dict'
    RETURNING news_id, ticker
  `);
  const purgedRows = (purged.rows ?? purged) as any[];
  console.log(`  purged ${purgedRows.length} rows`);

  // Borrar también rows regex de tickers API-only que se autoetiquetaron
  // por $X mention (poco común, pero limpio).
  const purgedRegex = await db.execute(sql`
    DELETE FROM news_tickers
    WHERE ticker = ANY(ARRAY[${sql.raw(API_ONLY.map((s) => `'${s}'`).join(","))}]::text[])
      AND extraction_method = 'regex'
    RETURNING news_id, ticker
  `);
  console.log(`  purged regex-method rows: ${(purgedRegex.rows ?? purgedRegex).length}`);

  console.log("\n=== top tickers after cleanup ===");
  const after = await db.execute(sql`
    SELECT ticker, COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE extraction_method = 'dict')::int AS dict_n,
      COUNT(*) FILTER (WHERE extraction_method = 'api')::int AS api_n
    FROM news_tickers
    GROUP BY ticker
    ORDER BY n DESC
    LIMIT 20
  `);
  for (const r of (after.rows ?? after) as any[]) {
    console.log(`  ${r.ticker.padEnd(8)} total=${String(r.n).padStart(5)}  dict=${r.dict_n}  api=${r.api_n}`);
  }

  // Borrar de la tabla `tickers` los símbolos huérfanos que ya no aparecen
  // en ninguna noticia (limpieza de SE, etc.).
  const orphaned = await db.execute(sql`
    DELETE FROM tickers t
    WHERE NOT EXISTS (SELECT 1 FROM news_tickers nt WHERE nt.ticker = t.symbol)
    RETURNING symbol
  `);
  const orphanedRows = (orphaned.rows ?? orphaned) as any[];
  if (orphanedRows.length) {
    console.log(`\n=== removed ${orphanedRows.length} orphan tickers (no news links) ===`);
    console.log("  " + orphanedRows.map((r) => r.symbol).join(", "));
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
