// Audita aliases problemáticos: cortos o palabras comunes que disparan
// falsos positivos masivos en el extractor.
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const COMMON_WORDS = new Set([
  "sea","target","intel","amd","ms","c","group","holdings","capital","bank",
  "global","international","corp","incorporated","inc","ltd","limited","co",
  "company","plc","ag","sa","spa","nv","oyj","ab","asa","real","trust","energy",
  "media","health","tech","data","systems","networks","resources","industries",
]);

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  console.log("=== short aliases (<=5 chars), all of them ===");
  const shorts = await db.execute(sql`
    SELECT alias, symbol FROM ticker_aliases WHERE length(alias) <= 5 ORDER BY length(alias), alias
  `);
  for (const r of (shorts.rows ?? shorts) as Array<{ alias: string; symbol: string }>) {
    const flag = COMMON_WORDS.has(r.alias.toLowerCase()) ? "  ⚠ COMMON" : "";
    console.log(`  ${r.alias.padEnd(8)} → ${r.symbol}${flag}`);
  }

  console.log("\n=== aliases matching common english words (any length) ===");
  const all = await db.execute(sql`SELECT alias, symbol FROM ticker_aliases`);
  const flagged: Array<{ alias: string; symbol: string }> = [];
  for (const r of (all.rows ?? all) as Array<{ alias: string; symbol: string }>) {
    if (COMMON_WORDS.has(r.alias.toLowerCase())) {
      flagged.push(r);
      console.log(`  ${r.alias.padEnd(20)} → ${r.symbol}`);
    }
  }

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
