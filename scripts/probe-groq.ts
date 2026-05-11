import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { groqChatCompletion } = await import("../lib/providers/groq");
  for (let i = 0; i < 6; i++) {
    const t = Date.now();
    try {
      const r = await groqChatCompletion({
        messages: [{ role: "user", content: `Reply with the word OK only. (${i})` }],
        maxTokens: 8,
      });
      console.log(`[${i}] ${Date.now() - t}ms model=${r.model} content="${r.content.slice(0, 30)}"`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[${i}] ${Date.now() - t}ms ERROR ${msg.slice(0, 100)}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
