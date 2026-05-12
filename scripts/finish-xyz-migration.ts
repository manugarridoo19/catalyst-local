// Block Inc cambió ticker de SQ → XYZ en Aug 2025. El alias `Block Inc`
// sigue apuntando a SQ en la DB. Migrarlo a XYZ (alias es PK único, así
// que el INSERT conflictaba — usamos UPDATE).
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import { sql } from "drizzle-orm";
async function main() {
  const { db } = await import("../lib/db");
  // Pre-state
  const before = await db.execute(sql`
    SELECT symbol, alias FROM ticker_aliases
    WHERE alias IN ('Block', 'Block Inc') OR symbol IN ('XYZ', 'SQ')
    ORDER BY symbol, alias
  `);
  console.log("Before:");
  for (const x of (((before as { rows?: unknown[] }).rows ?? (before as unknown as unknown[])))) console.log("  ", x);

  // Migrate Block Inc → XYZ
  const upd = await db.execute(sql`
    UPDATE ticker_aliases SET symbol = 'XYZ'
    WHERE alias = 'Block Inc' AND symbol = 'SQ'
    RETURNING alias, symbol
  `);
  const updRows = ((upd as { rows?: unknown[] }).rows ?? (upd as unknown as unknown[]));
  console.log(`\nMigrated 'Block Inc' SQ→XYZ: ${updRows.length} row(s)`);

  // Post-state
  const after = await db.execute(sql`
    SELECT symbol, alias FROM ticker_aliases
    WHERE alias IN ('Block', 'Block Inc') OR symbol IN ('XYZ', 'SQ')
    ORDER BY symbol, alias
  `);
  console.log("\nAfter:");
  for (const x of (((after as { rows?: unknown[] }).rows ?? (after as unknown as unknown[])))) console.log("  ", x);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
