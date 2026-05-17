import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { chatCompletion } = await import("../lib/providers/openrouter");
  const r = await chatCompletion({
    messages: [
      { role: "system", content: 'Output strict JSON: {"impact":<1-5>,"sentiment":<-5..5>,"category":"EARNINGS","rationale":"..."}' },
      { role: "user", content: "Headline: Apple beats Q1 earnings, raises FY guide on iPhone strength" },
    ],
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    maxTokens: 200,
    jsonMode: true,
  });
  console.log("model returned:", r.model);
  console.log("content:", JSON.stringify(r.content));
  console.log("usage:", r.usage);
}
main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
