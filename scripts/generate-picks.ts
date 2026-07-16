import { config } from "dotenv";
config({ path: ".env.local" });

// Genera AI Picks manualmente (ignora el age check).
//   pnpm exec tsx scripts/generate-picks.ts
async function main() {
  const { generatePicks } = await import("../lib/ai/picks");
  const row = await generatePicks();
  console.log(
    `[picks] generated at ${row.generatedAt.toISOString()} by ${row.model} (${row.newsCount} headlines read)\n`,
  );
  for (const p of row.picks) {
    console.log(`■ ${p.symbol} — ${p.thesis}`);
    if (p.catalysts.length) console.log(`  catalysts: ${p.catalysts.join(" · ")}`);
    if (p.caution) console.log(`  ⚠ ${p.caution}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[picks] FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
