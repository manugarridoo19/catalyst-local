@AGENTS.md

# Catalyst Local — project conventions

Realtime market news dashboard inspired by Catalist.Live. Free-tier-only stack.

## Stack

- **Hosting: Cloudflare Workers** via `@opennextjs/cloudflare` (migrated off Vercel 2026-07-15 — see "Hosting" below). Live at `https://catalyst-local.manubisbal19.workers.dev`.
- **Next.js 16** (App Router, Turbopack) + **React 19** + **Tailwind 4** + **shadcn/ui** (base-nova preset)
- **Drizzle ORM** + **Neon Postgres** via `@neondatabase/serverless`. **TWO clients (lib/db/index.ts)** — this matters:
  - `db` (global, ALL reads) = **HTTP driver** (`drizzle/neon-http` + `neon()`). Stateless: each query is an independent fetch. This is MANDATORY on Workers — a global `Pool` (WebSocket) shares an I/O object across requests in the same isolate and throws `Cannot perform I/O on behalf of a different request` intermittently (ticker pages were 500 on ~1 of every 2 loads, alternating). NEVER put a module-level Pool/WebSocket/stream back on the hot path.
  - `createTxDb()` (on-demand) = **Pool** (`drizzle/neon-serverless`) for interactive transactions only (insertNewsBatch reads an intermediate INSERT result to build the next). Node-only (cron/daemon/scripts), never the Worker; caller must `close()` in `finally`.
- **LLM stack (2026-07-16)**: OpenRouter primary → **Gemini** (Google AI Studio, `lib/providers/gemini.ts`) → Groq last resort (`SCORER_PRIMARY` env overrides the head). Gemini pool = **3 primary keys** (`GEMINI_API_KEYS`) rotated **round-robin per request** (its binding limit is RPM, not daily like OpenRouter — round-robin makes N keys ≈ N× RPM) + **1 RESERVE key** (`GEMINI_RESERVE_API_KEYS`, the user's MAIN Google account) used ONLY when every primary is cooled — minimal volume = near-human profile = smallest multi-account ban surface for the account we least want to lose. Model `gemini-3.1-flash-lite` (2.5-flash-lite is closed to new accounts), fallback `gemini-2.0-flash-lite`. 429s classified: daily → cool until Pacific midnight (~07:05Z), RPM burst → `retryDelay`+2s. `tryTier` skip-and-continues on ANY per-key error (a hard error must not wedge the whole tier). Keys off-repo in `~/.catalyst-gemini-keys` (mode 600) + GH/Worker secrets. Every request sends `thinkingConfig:{thinkingBudget:0}`. User-facing prose → `lib/ai/prose-chain.ts` (openrouter task="brief" → gemini → groq 70b → 8b). OpenRouter chains **per task** in `lib/providers/openrouter.ts`:
  - `scoring`: `nemotron-3-ultra` → `llama-3.3-70b` → `gemma-4-31b` → `nemotron-3-nano-omni-reasoning`
  - `brief` (prose): `nemotron-3-ultra` → `gemma-4-31b` → `llama-3.3-70b` → `qwen3-next-80b`
  - `author` (Author Watch daily fusion): reasoning models WITH `reasoning:true` — the ONLY chain that reasons on purpose (1 call/day makes it affordable; anti-scratchpad guard protects). Everything else sends `reasoning:{enabled:false}`.
- **Scoring is batched (v4.1)**: `scoreNewsBatch()` sends up to 10 news/call, returning per-item scores + `wrong_tickers` + a plain-English **`summary`** for impact>=4 items only (the per-item AI summary — same call, ~0 marginal cost; `news_scores.summary`, shown in the expanded card). Don't revert to 1-call-per-news. The picker (`lib/cron/score-orphans.ts`) is **hybrid**: 2/3 newest + 1/3 oldest-backlog (anti-starvation), skips items with `scoring_attempts>=5` (abandoned) and `published_at` older than 5 days. Unscored news >5 days is purged (`deleteUnscoredOlderThan`, UNSCORED_RETENTION_DAYS); scored news lives to 20 days.
- **Pusher Channels** for realtime broadcast to clients
- **News sources (6)**: Finnhub (general + per-company), Marketaux, RSS aggregator, Google News per-ticker, and **SEC EDGAR** (`lib/providers/sec-edgar.ts` — 8-K + Form 4, CIK→ticker via official `company_tickers.json`, filtered to `knownSymbols`, Node-only). Quotes/search via Finnhub; historical bars via Yahoo.
- **FMP (Financial Modeling Prep)** — `lib/providers/fmp.ts`, `/stable/` endpoints (v3/v4 are legacy, rejected for post-Aug-2025 keys). Gives P/E, beta, 52w range, peers (what Finnhub free doesn't). **Free tier 250 calls/day** → strict discipline: NEVER per-pageview, cached 7d in `ticker_fundamentals` via `getOrFetchFundamentals` (lib/fundamentals.ts). 3 calls/symbol. Key in `~/.catalyst-fmp-key` (mode 600) + GH/Worker secret.

## Commit conventions

- Commit email: `manubisbal19@gmail.com` (already set in local git config; also the Cloudflare account email)
- **NO `Co-Authored-By` trailer** — established convention for this repo
- Commit on every meaningful milestone, not in batches

## Cron strategy — DECIDED. Do not change without re-reading the post-mortem.

**The cron runs in GitHub Actions, on the runner itself. Vercel is never
invoked in the cron path.** This is the result of the 2026-05-17 Vercel
suspension post-mortem: duplicated cron + 5-min cadence + polling burned
300% of the Hobby Fluid Active CPU cap in 4 days. See
`feedback_catalyst_vercel_budget` in user memory for the full incident.

- Workflow: `.github/workflows/cron-runner.yml` runs `*/5 * * * *`
- Script: `scripts/cron-runner.ts` (`pnpm cron:remote`)
- The script connects directly to Neon, Pusher, Groq/OpenRouter
- `vercel.json` is intentionally empty (no Vercel crons)
- The repo is **public** so GH Actions minutes are unlimited

**Forbidden moves** (these all re-introduce the original failure):
- Re-adding any cron to `vercel.json`
- Re-creating any `app/api/cron/*` endpoint
- Re-enabling cron-job.org or any external prodder that hits Vercel
- Making the repo private without first re-budgeting the GH Actions minutes

`CRON_SECRET` is legacy — the Vercel cron endpoints were deleted on
2026-05-17. If you see it referenced anywhere outside this file, that's
dead code; remove it.

Manual trigger if needed: `gh workflow run cron-runner.yml -R manugarridoo19/catalyst-local`

## Hosting — Cloudflare Workers (migrated off Vercel 2026-07-15)

**Vercel is abandoned** (account suspended since May; not coming back). Public
site is a Cloudflare Worker: `https://catalyst-local.manubisbal19.workers.dev`.

- **Adapter**: `@opennextjs/cloudflare` (Workers with `nodejs_compat`, so
  `runtime="nodejs"` routes and the Neon driver work). NOT `next-on-pages`
  (edge-only — would break the DB). Config: `wrangler.jsonc`,
  `open-next.config.ts`, `initOpenNextCloudflareForDev()` in `next.config.ts`,
  `serverExternalPackages: ["@neondatabase/serverless"]`.
- **Deploy**: `set -a; source ~/.catalyst-cf-token; set +a; pnpm cf:build && pnpm cf:deploy`.
  ⚠️ **`cf:deploy` does NOT rebuild** — it uploads whatever is already in
  `.open-next/`. Skipping `cf:build` silently ships a stale bundle (bitten
  2026-07-16: three deploys shipped the previous day's build). Auth is a
  long-lived API token in `~/.catalyst-cf-token` (mode 600,
  `CLOUDFLARE_API_TOKEN=…`), NOT `wrangler login` (OAuth expires). Scripts:
  `cf:build` / `cf:preview` / `cf:deploy`.
- **Secrets**: on the Worker via `wrangler secret bulk` (persist across
  deploys). `.dev.vars` (gitignored) mirrors `.env.local` for local preview.
  **NEVER upload `LOCAL_MODE` / `LOCAL_DEFAULT_SESSION_ID` to the Worker** —
  they'd pin every anonymous visitor to one user's watchlist.
- Flags live only in `wrangler.jsonc` (wrangler 4.92+ rejects `--compatibility-flag` on the CLI).
- Desktop launcher: `~/Desktop/Catalyst.app` (opens localhost:3030 if the
  daemon is up, else the public URL, in Brave app-mode).

## File organization

- `/app` — Next.js App Router pages + route handlers
- `/components` — UI (feed, watchlist, ticker, search, ui)
- `/lib` — providers, db, scoring, tickers, pusher, types
- `/scripts` — local-only scripts (`run-cron-local.ts`)
- `/drizzle/migrations` — committed schema migrations
- `/tests` — vitest (TBD)

## Architecture rules

- **Universe is dynamic.** Tickers enter the `tickers` table only when a provider mentions them. Don't hardcode an SP500 list.
- **Providers must be resilient.** All cron fetches go through `Promise.allSettled` — a failing source must not tumble the cycle.
- **Scoring caps.** score-orphans picks `ORPHAN_BATCH=30` per tick, scored in 3 batched LLM calls of 10. The Worker never scores — scoring lives in the GH Actions cron + the local scorer daemon.
- **Ticker extraction quality.** Single-word aliases live or die by `lib/tickers/alias-denylist.ts` (SHARED by extractor match-time + enricher creation-time — never fork it back into two lists). gnews search hints are only accepted when `mentionsTicker()` confirms the text actually mentions the company. One-time cleanups: `scripts/cleanup-mislinks.ts --dry-run`.
- **publishedAt is clamped at ingestion** (refresh-news): anything >2min in the future becomes `now` — investing.com emits pubDates ~3h ahead and future dates pin to the top of every `publishedAt DESC` feed.
- **Score 1-5 + sentiment -5..+5.** Don't change the range without bumping `PROMPT_VERSION` in `lib/scoring/prompt.ts`.
- **`NEXT_PUBLIC_PUSHER_*`** are the only client-side Pusher creds; `PUSHER_SECRET` is server-only and never exposed.

## Build & test

```bash
pnpm dev              # local dev server (port 3000)
pnpm build            # production build
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint
pnpm db:generate      # generate migration after schema changes
pnpm db:migrate       # apply migrations to Neon
pnpm cron:local       # run cron pipeline once locally
```

## Local daemon — fast local access with pinned watchlist

The public Worker is anonymous (no `LOCAL_MODE`), so the user's watchlist
won't auto-appear there. For daily personal use the dashboard serves from
`localhost:3030` via a macOS LaunchAgent that runs the prod `next start`
build, auto-restarts on crash, and pins the user's session UUID via env
vars so the watchlist appears without manual cookie injection. The repo
lives at `~/dev/catalyst-local` (moved off `~/Desktop` — iCloud File
Provider broke launchd reads there).

```bash
pnpm daemon:install   # First-time setup: builds, installs plist, starts agent
pnpm daemon:status    # Show plist + agent + port + URL
pnpm daemon:logs      # Tail stdout + stderr
pnpm daemon:restart   # Stop, rebuild if source newer, start
pnpm daemon:stop      # Unload agent + kill any stray listener
```

- Port: `3030` (chosen to coexist with `pnpm dev` on 3000)
- Plist source: `scripts/com.catalyst.local.plist`
- Installed at: `~/Library/LaunchAgents/com.catalyst.local.plist`
- Logs: `.next/daemon-logs/{stdout,stderr}.log`
- RAM: ~130-200MB RSS (bounded by `--max-old-space-size=512` in plist)

**Session pinning**: set `LOCAL_DEFAULT_SESSION_ID=<your-uuid>` in the user
environment or `.env.local`. Combined with `LOCAL_MODE=1` (set by the
plist), `lib/session.ts` falls back to that UUID when no cookie is
present. Never set `LOCAL_MODE=1` on the public Worker (or any shared
host) — would pin all anonymous users to the same watchlist.

**TCC gotcha**: the plist uses `pnpm --dir /abs/path` instead of a shell
wrapper because LaunchAgents cannot `chdir` into TCC-protected dirs on
modern macOS without Full Disk Access for `/bin/bash`. The `--dir` flag
dodges the issue.

### Auto-scorer (second LaunchAgent)

A companion `com.catalyst.scorer` agent runs
`drain-scoring.ts 30` every 15 minutes from your Mac. It complements
the GH Actions cron (which GitHub throttles to 1-4h intervals on public
repos) by firing smaller, faster bursts. With batch scoring v4 each
tick costs ~3 LLM calls for 30 items, so quota is no longer the
bottleneck.

### Refresher (third LaunchAgent, 2026-07-16)

`com.catalyst.refresher` runs `refresh-once.ts` every 10 minutes:
full news fetch + insert + Pusher broadcast from the Mac, covering the
gaps GitHub's throttling leaves (without it the feed advanced in
1-2h bursts). Its plist sets `SKIP_MARKETAUX=1` — Marketaux free tier
is 100 req/day and only flows in via the GH Actions cron. Control:
`pnpm refresher:{install,status,logs,stop,run}`.

### AI Brief

`lib/ai/brief.ts` turns the top-30 scored news of the last 24h
(impact≥3) + the watchlist into a 5-8 bullet desk-style digest
(watchlist bullets starred). Regenerates when the latest is >4h old —
wired into both cron-runner and refresh-once, so real cadence is
~4-6/day. Stored in `ai_briefs` (last 20 kept), rendered by
`components/feed/brief-panel.tsx` (server-side `<details>` strip above
the live feed). Manual run: `pnpm exec tsx scripts/generate-brief.ts`.

```bash
pnpm scorer:install   # First-time: copy plist + load + run immediately
pnpm scorer:status    # Both daemons' state (same as pnpm daemon:status)
pnpm scorer:logs      # Tail scorer stdout + stderr
pnpm scorer:stop      # Unload (kills any in-flight drain)
pnpm scorer:run       # One-shot foreground tick, useful for debugging
```

The scorer plist uses `pnpm exec tsx scripts/drain-scoring.ts` rather
than `pnpm tsx ...` — the latter triggers
`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` because `tsx` isn't in the
package.json scripts. Same TCC workaround as the main daemon.

## OpenRouter key pool

Free-tier scoring uses a pool of OpenRouter API keys to multiply the
`free-models-per-day` cap (1000 calls/day account-wide). When a key
returns a 429 whose body contains `free-models-per-day`, the provider
marks that whole key cooled-down until the next 00:00 UTC and rotates
to the next available key. Per-model RPM/TPM 429s still fall through
the model fallback chain on the same key.

```bash
# .env.local  OR  GitHub Secrets
OPENROUTER_API_KEYS=sk-or-v1-aaa…,sk-or-v1-bbb…,sk-or-v1-ccc…
# Or single-key (back-compat):
OPENROUTER_API_KEY=sk-or-v1-aaa…
```

`getKeyPoolStatus()` in `lib/providers/openrouter.ts` returns the live
pool state (labels + cooldownUntil) without exposing the keys
themselves — wire it into a script or `/api/health` when you want to
see which keys are alive.

**Important**: OpenRouter ToS forbids multiple accounts per person.
Using key rotation across separate accounts carries account-ban risk
(detected via IP, payment fingerprint, or email pattern). This is a
user-accepted tradeoff; never document the multi-account technique
publicly or commit the keys.

## Common gotchas

- **DB result shape**: `@neondatabase/serverless` `db.execute(sql\`\`)` returns `{ rows, rowCount }`, NOT an array-like RowList (postgres-js did). Use `unwrapRows()` from `lib/db/index.ts` on raw execute results, and read `rowCount` for affected-row counts. Drizzle query-builders (`db.select()`) still return arrays. Don't reintroduce `postgres-js`.
- **No top-level await in `lib/db`** (or anything imported by tsx scripts) — tsx compiles scripts to CJS and rejects it. The `ws` fallback for Node <22 uses a guarded `require`.
- Drizzle Kit and tsx scripts need explicit `.env.local` loading via `dotenv` config — don't use `dotenv/config` since static imports are hoisted before env loads.
- Yahoo Finance unofficial may break — wrap calls in try/catch and degrade gracefully.
- OpenRouter `:free` models are frequently rate-limited upstream and the catalog changes (owl-alpha was pulled 2026-07 → 404). If a model 404s, check availability at `https://openrouter.ai/api/v1/models` and swap in the fallback chain (`lib/providers/openrouter.ts`). If all fail, news is left unscored (UI shows "—").
