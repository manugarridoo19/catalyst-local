import { config } from "dotenv";
config({ path: ".env.local" });

// Genera un AI Brief manualmente (ignora el age check).
//   pnpm exec tsx scripts/generate-brief.ts
async function main() {
  const { generateBrief } = await import("../lib/ai/brief");
  const brief = await generateBrief();
  console.log(`[brief] generated at ${brief.generatedAt.toISOString()} by ${brief.model}\n`);
  console.log(brief.content);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[brief] FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
