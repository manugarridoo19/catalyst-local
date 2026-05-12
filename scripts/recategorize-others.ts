// Re-aplica el categorizer mejorado sobre news existentes con category=OTHER
// o NULL. Solo cambia la category si el nuevo categorizer la mueve a algo
// más específico que OTHER.
//
//   pnpm tsx scripts/recategorize-others.ts [--dry]

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const DRY = process.argv.includes("--dry");
  const { db, unwrapRows } = await import("../lib/db");
  const { news } = await import("../lib/db/schema");
  const { sql, eq } = await import("drizzle-orm");
  const { categorizeHeuristic } = await import("../lib/categorizer");

  console.log(`[recategorize] ${DRY ? "DRY RUN" : "LIVE"}\n`);

  const rows = await db.execute(sql`
    SELECT id, headline, body, source, category
    FROM news
    WHERE (category = 'OTHER' OR category IS NULL)
      AND published_at > NOW() - INTERVAL '20 days'
    ORDER BY published_at DESC
  `);
  const items = unwrapRows<{
    id: number;
    headline: string;
    body: string | null;
    source: string;
    category: string | null;
  }>(rows);
  console.log(`[recategorize] scanning ${items.length} news`);

  const byNew = new Map<string, number>();
  let changed = 0;

  for (const r of items) {
    const newCat = categorizeHeuristic({
      headline: r.headline,
      body: r.body,
      source: r.source,
    });
    if (newCat === "OTHER" || newCat === r.category) continue;
    byNew.set(newCat, (byNew.get(newCat) ?? 0) + 1);
    changed++;
    if (!DRY) {
      await db.update(news).set({ category: newCat }).where(eq(news.id, r.id));
    } else if (changed <= 20) {
      console.log(`  ${r.id} → ${newCat}: ${r.headline.slice(0, 90)}`);
    }
  }

  console.log(`\n[recategorize] would change ${changed}/${items.length}`);
  console.log("\nDistribution of moves:");
  for (const [cat, n] of [...byNew.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(12)} ${n}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
