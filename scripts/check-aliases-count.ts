import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const fetch = async (q: ReturnType<typeof sql>): Promise<number> => {
    const r = await db.execute(q);
    const rows = unwrapRows<{ c: number }>(r);
    return rows[0]?.c ?? 0;
  };

  const t = await fetch(sql`SELECT count(*)::int AS c FROM tickers`);
  const a = await fetch(sql`SELECT count(*)::int AS c FROM ticker_aliases`);
  const nt = await fetch(sql`SELECT count(*)::int AS c FROM news_tickers`);
  const orph = await fetch(sql`
    SELECT count(*)::int AS c FROM news n
    WHERE NOT EXISTS (SELECT 1 FROM news_tickers WHERE news_id = n.id)
  `);
  const newsTot = await fetch(sql`SELECT count(*)::int AS c FROM news`);
  const coverage = newsTot ? (((newsTot - orph) / newsTot) * 100).toFixed(1) : "—";

  console.log(`tickers:        ${t}`);
  console.log(`ticker_aliases: ${a}`);
  console.log(`news_tickers:   ${nt}`);
  console.log(`news total:     ${newsTot}`);
  console.log(`news w/o ticker:${orph}`);
  console.log(`coverage:       ${coverage}%`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
