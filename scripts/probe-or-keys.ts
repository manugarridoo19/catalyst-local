import { config } from "dotenv";
config({ path: ".env.local" });

async function probe(label: string, key: string) {
  const masked = key.slice(0, 16) + "..." + key.slice(-4);
  try {
    const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await r.text();
    console.log(`${label.padEnd(20)} ${masked}  HTTP ${r.status}`);
    if (body.length < 400) console.log("  →", body);
    else console.log("  →", body.slice(0, 200) + "...");
  } catch (e) {
    console.log(`${label.padEnd(20)} ${masked}  ERR`, (e as Error).message);
  }
}

async function main() {
  const single = process.env.OPENROUTER_API_KEY?.trim();
  if (single) {
    await probe("env.OPENROUTER_API_KEY", single);
  } else {
    console.log("No OPENROUTER_API_KEY in env");
  }
  const multi = (process.env.OPENROUTER_API_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length) {
    let i = 0;
    for (const k of multi) {
      i++;
      await probe(`env.KEYS[${i}]`, k);
    }
  } else {
    console.log("No OPENROUTER_API_KEYS in env");
  }
}

main();
