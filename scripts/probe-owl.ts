import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

// Experimento controlado: descubrir el rate-limit real de owl-alpha vía
// (a) headers de OpenRouter (X-RateLimit-*) (b) timing entre 429 y siguiente
// 200 (c) si hay un per-day cap visible.

async function callOwl(): Promise<{
  status: number;
  latency: number;
  headers: Record<string, string>;
  body: string;
}> {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const t0 = Date.now();
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
      messages: [{ role: "user", content: 'Respond with the single word "ok".' }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  const latency = Date.now() - t0;
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (
      k.toLowerCase().includes("rate") ||
      k.toLowerCase().includes("limit") ||
      k.toLowerCase().includes("retry") ||
      k.toLowerCase().includes("reset")
    ) {
      headers[k] = v;
    }
  });
  const body = await res.text();
  return { status: res.status, latency, headers, body: body.slice(0, 400) };
}

async function fetchKeyInfo() {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return await res.json();
}

async function main() {
  console.log("=== OpenRouter key info ===");
  console.log(JSON.stringify(await fetchKeyInfo(), null, 2));

  console.log("\n=== Burst test: 5 calls back-to-back ===");
  for (let i = 0; i < 5; i++) {
    const r = await callOwl();
    console.log(
      `[${i + 1}] status=${r.status} latency=${r.latency}ms headers=${JSON.stringify(r.headers)}`,
    );
    if (r.status !== 200) console.log(`    body: ${r.body}`);
  }

  console.log("\n=== Spaced test: 1 call every 3s ===");
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const r = await callOwl();
    console.log(
      `[${i + 1}] status=${r.status} latency=${r.latency}ms headers=${JSON.stringify(r.headers)}`,
    );
    if (r.status !== 200) console.log(`    body: ${r.body}`);
  }

  console.log("\n=== Spaced test: 1 call every 15s ===");
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const r = await callOwl();
    console.log(
      `[${i + 1}] status=${r.status} latency=${r.latency}ms headers=${JSON.stringify(r.headers)}`,
    );
    if (r.status !== 200) console.log(`    body: ${r.body}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
