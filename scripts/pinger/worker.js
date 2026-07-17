// Despierta el cron-runner de GitHub Actions vía workflow_dispatch.
// Ver wrangler.toml para el porqué. Idempotente y sin estado: si el
// dispatch coincide con un run en curso, el concurrency group del
// workflow colapsa los pendientes — no hay estampida posible.
const pinger = {
  async scheduled(_event, env) {
    const res = await fetch(
      "https://api.github.com/repos/manugarridoo19/catalyst-local/actions/workflows/cron-runner.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "catalyst-pinger",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.status !== 204) {
      console.error(`dispatch failed: ${res.status} ${await res.text()}`);
    }
  },
};

export default pinger;
