import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db");
  const { watchlist } = await import("../lib/db/schema");
  const { sql } = await import("drizzle-orm");

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(watchlist);
  const bySession = await db
    .select({
      session: watchlist.userSession,
      count: sql<number>`count(*)::int`,
    })
    .from(watchlist)
    .groupBy(watchlist.userSession)
    .orderBy(sql`count(*) desc`)
    .limit(10);

  console.log(`Total watchlist rows: ${totalRows[0]?.count ?? 0}`);
  console.log("Top sessions by symbol count:");
  for (const r of bySession) {
    const masked = r.session.slice(0, 8) + "…" + r.session.slice(-4);
    console.log(`  ${masked}  →  ${r.count} symbols`);
  }

  if (bySession.length) {
    const topSession = bySession[0].session;
    const symbols = await db
      .select({ symbol: watchlist.symbol })
      .from(watchlist)
      .where(sql`${watchlist.userSession} = ${topSession}`)
      .orderBy(watchlist.addedAt);
    console.log(
      `\nSymbols in top session: ${symbols.map((s) => s.symbol).join(", ")}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
