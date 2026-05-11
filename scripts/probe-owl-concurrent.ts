import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function callOwl(idx: number) {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://catalyst-local.local",
        "X-Title": "Catalyst Local probe",
      },
      body: JSON.stringify({
        model: "openrouter/owl-alpha",
        messages: [{ role: "user", content: `Reply with: ${idx}` }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    const body = await res.text();
    return { idx, status: res.status, latency: Date.now() - t0, body: body.slice(0, 100) };
  } catch (err) {
    return { idx, status: -1, latency: Date.now() - t0, body: String(err) };
  }
}

async function main() {
  for (const c of [2, 4, 8]) {
    console.log(`\n=== ${c} concurrent calls ===`);
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: c }, (_, i) => callOwl(i + 1)),
    );
    const total = Date.now() - t0;
    let ok = 0, err = 0;
    for (const r of results) {
      if (r.status === 200) ok++;
      else err++;
      console.log(`  [${r.idx}] ${r.status} ${r.latency}ms${r.status !== 200 ? " " + r.body : ""}`);
    }
    console.log(`  → ok=${ok} err=${err} total=${total}ms`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
