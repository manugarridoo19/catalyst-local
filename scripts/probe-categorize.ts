// Probe: para un id concreto, identifica QUÉ patrón del categorizer fired
// (mostrando el match snippet) sobre headline + body. Útil para depurar
// FP/FN del categorizer.
//
//   pnpm tsx scripts/probe-categorize.ts <id> [<id> ...]

import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const ids = process.argv.slice(2).map((n) => Number(n)).filter(Boolean);
  if (!ids.length) { console.error("usage: tsx scripts/probe-categorize.ts <id>..."); process.exit(2); }

  const { db, unwrapRows } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  // PATTERNS no está exportado; no hace falta reflexión sobre el módulo —
  // usamos categorizeHeuristic + manual regex test.

  const rows = await db.execute(sql`
    SELECT id, headline, body, source, category
    FROM news WHERE id IN (${sql.raw(ids.join(","))})
  `);
  const items = unwrapRows<{ id: number; headline: string; body: string | null; source: string; category: string | null }>(rows);

  for (const r of items) {
    console.log(`\n===== ${r.id} [${r.source}] currentCat=${r.category} =====`);
    console.log(`HEADLINE: ${r.headline}`);
    console.log(`BODY: ${(r.body ?? "").slice(0, 1200)}`);
    const newCat = cat.categorizeHeuristic({ headline: r.headline, body: r.body, source: r.source });
    console.log(`→ NEW CATEGORY: ${newCat}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
