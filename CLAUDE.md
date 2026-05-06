@AGENTS.md

# Catalyst Local — project conventions

Realtime market news dashboard inspired by Catalist.Live. Free-tier-only stack.

## Stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + **Tailwind 4** + **shadcn/ui** (base-nova preset)
- **Drizzle ORM** + **Neon Postgres** (via Vercel Marketplace)
- **OpenRouter** free models for sentiment scoring (Llama 3.3 70B → Mistral Nemo → Qwen → Gemma → Llama 3.2 3B fallback chain)
- **Pusher Channels** for realtime broadcast to clients
- **Finnhub** REST + WebSocket for quotes/news/search; **Marketaux** + 7 RSS feeds for additional news; **Yahoo Finance** for historical bars

## Commit conventions (Vercel-deployed)

- Commit email: `manubisbal19@gmail.com` (already set in local git config)
- **NO `Co-Authored-By` trailer** — Vercel attribution rule
- Commit on every meaningful milestone, not in batches

## Cron strategy

Vercel Hobby plan limits crons to **once per day** (`vercel.json` has `0 12 * * *` UTC). For sub-minute realtime feel, use one of:

1. **GitHub Actions** (free, 5-min minimum): create `.github/workflows/cron.yml` with `*/5 * * * *` calling `curl -H "Authorization: Bearer $CRON_SECRET" https://catalyst-local.vercel.app/api/cron/refresh-news`
2. **cron-job.org** (free, 1-min): register the URL with the `Authorization: Bearer ...` header
3. **Local**: `pnpm cron:local` from the Mac when active

`CRON_SECRET` is in Vercel env (production) — don't expose.

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
- **Scoring has a cap.** `SCORING_BATCH=8` per cron run keeps us under Vercel's 60s function limit and respects OpenRouter free rate limits.
- **Score 1-5 + sentiment -5..+5.** Don't change the range without bumping `PROMPT_VERSION` in `lib/scoring/prompt.ts`.
- **`NEXT_PUBLIC_PUSHER_*`** are the only client-side Pusher creds; `PUSHER_SECRET` is server-only and never exposed.

## Build & test

```bash
pnpm dev              # local dev server
pnpm build            # production build
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint
pnpm db:generate      # generate migration after schema changes
pnpm db:migrate       # apply migrations to Neon
pnpm cron:local       # run cron pipeline once locally
```

## Common gotchas

- Drizzle Kit and tsx scripts need explicit `.env.local` loading via `dotenv` config — don't use `dotenv/config` since static imports are hoisted before env loads.
- Yahoo Finance unofficial may break — wrap calls in try/catch and degrade gracefully.
- OpenRouter `:free` models are frequently rate-limited upstream. The `chatCompletion` helper rotates through 5 models; if all fail, news is left unscored (UI shows "—").
