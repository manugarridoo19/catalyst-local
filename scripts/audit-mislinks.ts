import { config } from "dotenv";
config({ path: ".env.local" });

type Row = Record<string, unknown>;
const unwrap = (r: unknown): Row[] => {
  const w = r as { rows?: Row[] };
  return (w.rows ?? (r as Row[])) as Row[];
};

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");

  console.log("=== A) Aliases para los símbolos sospechosos del audit J ===");
  for (const sym of ["PFGC", "CNI", "GS", "KKR", "BX"]) {
    const a = await db.execute(sql`
      SELECT alias FROM ticker_aliases WHERE symbol = ${sym}
    `);
    console.log(`${sym}: ${unwrap(a).map((r) => `"${r.alias}"`).join(", ")}`);
  }

  console.log("\n=== B) Earnings news SIN ticker (sample, últimas 24h) ===");
  const earn = await db.execute(sql`
    SELECT id, headline, body
    FROM news n
    WHERE category = 'EARNINGS'
      AND published_at > NOW() - INTERVAL '24 hours'
      AND NOT EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
    ORDER BY published_at DESC LIMIT 15
  `);
  for (const r of unwrap(earn)) {
    console.log(`[${r.id}] ${String(r.headline).slice(0, 140)}`);
  }

  console.log("\n=== C) Aliases con 4 letras y verbo/objeto/concepto común ===");
  // Detección heurística — palabras que probablemente aparecen en headlines
  // genéricos sin ser referencias al ticker. Estos son candidatos al denylist.
  const risky = await db.execute(sql`
    SELECT alias, symbol,
      (SELECT COUNT(*)::int FROM news_tickers nt
        WHERE nt.ticker = ta.symbol AND nt.extraction_method = 'dict') AS dict_hits
    FROM ticker_aliases ta
    WHERE LENGTH(alias) BETWEEN 3 AND 5
      AND alias = INITCAP(alias)
      AND alias IN (
        'Arm','Iron','Meta','Palo','Snap','Korn','Plug','Mara','Riot',
        'Roku','Lyft','Snap','Salt','Rise','Lock','Wave','Beam','Open',
        'Buzz','Race','Gold','Live','Pure','Toll','Power','Best','Big'
      )
    ORDER BY dict_hits DESC
  `);
  console.table(unwrap(risky));

  console.log("\n=== D) Tickers never enriched (71 in audit-full E) ===");
  const ne = await db.execute(sql`
    SELECT symbol, source, first_seen_at
    FROM tickers
    WHERE enriched_at IS NULL
    ORDER BY first_seen_at DESC LIMIT 20
  `);
  console.table(unwrap(ne));

  console.log("\n=== E) Top tickers SIN ningún score (las que más news tienen) ===");
  const unscoredTop = await db.execute(sql`
    SELECT nt.ticker, COUNT(*)::int n
    FROM news_tickers nt
    JOIN news n ON n.id = nt.news_id
    WHERE n.published_at > NOW() - INTERVAL '24 hours'
      AND NOT EXISTS (SELECT 1 FROM news_scores ns WHERE ns.news_id = n.id)
    GROUP BY nt.ticker ORDER BY n DESC LIMIT 15
  `);
  console.table(unwrap(unscoredTop));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
