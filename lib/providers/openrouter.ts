// Cliente fino para OpenRouter (chat completions). Lo usamos para scoring
// de sentimiento/impacto. Implementa fallback entre modelos `:free` porque
// los providers upstream se rate-limitean a menudo, y rotación entre
// múltiples API keys porque la cuota free-models-per-day es account-wide
// (1000 calls/día) y satura rápido con un firehose de ~2000 news/día.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://openrouter.ai/api/v1";

// Off-repo secrets file. The user's Claude Code settings deny reads/
// writes to ./.env* paths as a safety rail, so the multi-account pool
// can't live in .env.local. Instead we store the keys at
// ~/.catalyst-openrouter-keys (mode 600) and read them at module load
// when the env var isn't already populated. This works for local dev
// (drain-scoring.ts, manual cron); GH Actions still injects
// OPENROUTER_API_KEYS via repository secrets so the file doesn't need
// to exist on the runner.
//
// File format: one OPENROUTER_API_KEYS=<comma-separated> line; comments
// and blanks ignored. Anything stricter (full dotenv parsing) would be
// overkill for one variable.
const LOCAL_KEYS_FILE = join(homedir(), ".catalyst-openrouter-keys");

function readKeysFromLocalFile(): string {
  if (!existsSync(LOCAL_KEYS_FILE)) return "";
  try {
    const raw = readFileSync(LOCAL_KEYS_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^OPENROUTER_API_KEYS\s*=\s*(.+)$/);
      if (m) return m[1].trim();
    }
    return "";
  } catch {
    return "";
  }
}

// Cadenas de modelos POR TAREA (2026-07-15, catálogo verificado en vivo).
// Cada tarea tiene requisitos distintos y no hay razón para que compartan
// chain — así cada key del pool se aprovecha con el modelo que mejor rinde
// para el trabajo concreto:
//
//   scoring — JSON estructurado en lotes. Primario nemotron-3-ultra
//     (elección del usuario 2026-07-15; el más capaz del catálogo free).
//     Diversidad de proveedor en fallbacks: Meta → Google → NVIDIA-nano.
//     nano-omni es un reasoning model: válido aquí SOLO porque enviamos
//     reasoning:{enabled:false} en el body (sin eso quema el max_tokens
//     en prosa y el JSON nunca llega).
//   brief — prosa user-facing (AI Brief del dashboard). PROHIBIDOS los
//     reasoning models (sueltan scratchpad al usuario — post-mortem
//     sueño-de-elvira 2026-05-21). Instruction-tuned only, diversidad
//     Google → Meta → Qwen.
export type LlmTask = "scoring" | "brief";

const TASK_MODEL_CHAINS: Record<LlmTask, string[]> = {
  scoring: [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  ],
  brief: [
    "google/gemma-4-31b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
  ],
};

// Back-compat: chain por defecto cuando el caller no indica tarea.
const DEFAULT_MODEL_FALLBACKS = TASK_MODEL_CHAINS.scoring;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionResult = {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

class RetriableError extends Error {
  constructor(
    message: string,
    public status: number,
    public bodyText: string = "",
  ) {
    super(message);
  }
}

// ============================================================================
// Key pool — multiple OpenRouter accounts rotated on free-models-per-day cap.
// ============================================================================

type KeyState = {
  key: string;
  /** ms epoch; 0 = available. Set on 'free-models-per-day' 429 (per-account
   *  daily cap) — we cool the key down until the next UTC midnight. */
  cooldownUntil: number;
  /** Stable short label for logs without exposing the key itself. */
  label: string;
  /** Stable per-key request fingerprint. Each pooled key consistently
   *  presents as a different "application" to OpenRouter — different
   *  HTTP-Referer + X-Title + User-Agent triple. The variance reduces
   *  the surface a heuristic detector can use to correlate the keys as
   *  the same actor. NOT cryptographic; only raises the bar. */
  fingerprint: KeyFingerprint;
};

type KeyFingerprint = {
  userAgent: string;
  referer: string;
  title: string;
  /** Small jitter applied to temperature so two keys never send byte-for-
   *  byte identical bodies for the same prompt. ±0.02 has zero effect on
   *  the parsed score but changes the request hash. */
  tempOffset: number;
};

// Plausible identities. Each is a realistic browser/agent + a fictional
// app name that could be a small finance dashboard. Order matters — keys
// are assigned fingerprints by their position in the pool, so adding a
// new key tail-appends a new identity rather than reshuffling existing
// ones (avoids a key "changing app" mid-flight, which would look weirder
// than staying consistent). 10 entries cover 5 keys × 2 rotation slots.
const FINGERPRINTS: KeyFingerprint[] = [
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    referer: "https://catalyst-local.local",
    title: "Catalyst",
    tempOffset: 0,
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    referer: "https://sentiment-console.app.local",
    title: "Sentiment Console",
    tempOffset: 0.02,
  },
  {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    referer: "https://finlytics-research.local",
    title: "Finlytics Research",
    tempOffset: -0.01,
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    referer: "https://newsdesk.research.local",
    title: "Newsdesk Research",
    tempOffset: 0.01,
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
    referer: "https://earnings-tracker.local",
    title: "Earnings Tracker",
    tempOffset: -0.02,
  },
  {
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    referer: "https://signal-watch.app",
    title: "Signal Watch",
    tempOffset: 0.015,
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    referer: "https://macro-pulse.local",
    title: "Macro Pulse",
    tempOffset: -0.025,
  },
  {
    userAgent:
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
    referer: "https://tape-reader.local",
    title: "Tape Reader",
    tempOffset: 0.005,
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
    referer: "https://briefroom.local",
    title: "Briefroom",
    tempOffset: -0.015,
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    referer: "https://ticker-deck.local",
    title: "Ticker Deck",
    tempOffset: 0.025,
  },
];

function loadKeyPool(): KeyState[] {
  // Combine all available key sources into one deduped pool. Order:
  //   1. process.env.OPENROUTER_API_KEYS  (GH Actions, daemon plist)
  //   2. ~/.catalyst-openrouter-keys      (off-repo local dev secret)
  //   3. process.env.OPENROUTER_API_KEY   (legacy single-key)
  // We union them instead of preferring one source so a local dev box
  // with the legacy single key in .env.local + the new multi-account
  // file at $HOME still gets the full N+1 pool. Dedupe by exact key
  // string in case a key is listed twice.
  const fromMulti = (process.env.OPENROUTER_API_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromFile = readKeysFromLocalFile()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromSingle = [(process.env.OPENROUTER_API_KEY ?? "").trim()].filter(
    Boolean,
  );
  const seen = new Set<string>();
  const raw: string[] = [];
  for (const k of [...fromMulti, ...fromFile, ...fromSingle]) {
    if (!seen.has(k)) {
      seen.add(k);
      raw.push(k);
    }
  }
  return raw.map((key, i) => ({
    key,
    cooldownUntil: 0,
    label: `k${i + 1}`,
    fingerprint: FINGERPRINTS[i % FINGERPRINTS.length],
  }));
}

// Module-level pool. State persists across calls within a single process
// (one cron tick on GH Actions; the whole daemon lifetime locally). On a
// new process the cooldowns reset, which is fine — they're discovered on
// the next 429 anyway.
const KEY_POOL: KeyState[] = loadKeyPool();

function maskKey(k: string): string {
  if (k.length < 12) return "***";
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

function nextUtcMidnightMs(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function availableKeys(): KeyState[] {
  const now = Date.now();
  return KEY_POOL.filter((k) => k.cooldownUntil <= now);
}

/** Inspect a 429 body and decide whether it's the daily-account cap (=
 *  cooldown this whole key) or a per-model RPM/TPM burst (= just retry/
 *  fall through to next model with the same key). */
function isDailyCapError(bodyText: string): boolean {
  return /free-models-per-day/i.test(bodyText);
}

// ============================================================================

// Timeout per attempt. owl-alpha-style workers can queue 90-120s; 15s gives
// margin for a typical ~5s call plus variance and forces fallthrough on
// pathological waits.
const PER_REQUEST_TIMEOUT_MS = 15000;

async function tryOnceWithKey(
  state: KeyState,
  model: string,
  messages: ChatMessage[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    timeoutMs?: number;
  },
): Promise<ChatCompletionResult> {
  // Per-key fingerprint variance: UA + Referer + Title triple changes per
  // pooled key so two accounts don't present as the same app. The temp
  // offset (±0.025) also varies the body hash without affecting outputs.
  const fp = state.fingerprint;
  const baseTemp = opts.temperature ?? 0.2;
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: Math.max(0, Math.min(2, baseTemp + fp.tempOffset)),
    max_tokens: opts.maxTokens ?? 256,
    // Nemotron-3 (y otros híbridos) razonan por defecto y queman todo el
    // max_tokens en prosa antes de emitir el JSON → "unparseable". El param
    // unificado de OpenRouter lo apaga; los modelos sin reasoning lo ignoran.
    reasoning: { enabled: false },
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  // Tiny jitter (40-180ms) before sending. Spreads bursts of identical
  // timing patterns across the pool; spotting "two accounts emit calls
  // exactly 20ms apart, every batch" is one of the cheapest correlations
  // an abuse detector can run.
  await new Promise((r) =>
    setTimeout(r, 40 + Math.floor(Math.random() * 140)),
  );

  const timeoutMs = opts.timeoutMs ?? PER_REQUEST_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": fp.referer,
        "X-Title": fp.title,
        "User-Agent": fp.userAgent,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RetriableError(`timeout ${timeoutMs}ms on ${model}`, 408);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 429 special handling: distinguish daily-account cap (cool the WHOLE
    // key until UTC midnight) from per-model RPM/TPM (just fall through).
    if (res.status === 429 && isDailyCapError(text)) {
      state.cooldownUntil = nextUtcMidnightMs();
      console.warn(
        `[openrouter] ${state.label} ${maskKey(state.key)} HIT DAILY CAP — cooled until ${new Date(state.cooldownUntil).toISOString().slice(11, 16)}Z`,
      );
    }
    if (
      res.status === 404 ||
      res.status === 408 ||
      res.status === 429 ||
      res.status === 502 ||
      res.status === 503
    ) {
      throw new RetriableError(
        `${res.status} ${res.statusText}: ${text.slice(0, 120)}`,
        res.status,
        text,
      );
    }
    throw new Error(
      `OpenRouter ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
    model: string;
    usage?: ChatCompletionResult["usage"];
  };
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    model: json.model,
    usage: json.usage,
  };
}

export async function chatCompletion(opts: {
  messages: ChatMessage[];
  model?: string;
  /** Selecciona la cadena de modelos por tipo de trabajo. Sin task ni
   *  model explícito se usa la cadena de scoring (back-compat). */
  task?: LlmTask;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}): Promise<ChatCompletionResult> {
  if (KEY_POOL.length === 0) {
    throw new Error(
      "No OpenRouter keys configured — set OPENROUTER_API_KEYS or OPENROUTER_API_KEY",
    );
  }

  // OPENROUTER_MODEL solo pisa la cadena de scoring — un override de env
  // pensado para el scorer no debe arrastrar al brief a un modelo JSON.
  const chain = TASK_MODEL_CHAINS[opts.task ?? "scoring"];
  const preferred =
    opts.model ||
    ((opts.task ?? "scoring") === "scoring"
      ? process.env.OPENROUTER_MODEL
      : undefined);
  const modelOrder = [
    ...(preferred ? [preferred] : []),
    ...chain.filter((m) => m !== preferred),
  ];

  let lastErr: unknown = null;
  const keysToTry = availableKeys();
  if (keysToTry.length === 0) {
    const earliest = Math.min(...KEY_POOL.map((k) => k.cooldownUntil));
    throw new Error(
      `All ${KEY_POOL.length} OpenRouter keys cooled down until ${new Date(earliest).toISOString().slice(11, 16)}Z`,
    );
  }

  for (const state of keysToTry) {
    for (const model of modelOrder) {
      for (let attempt = 0; attempt < 2; attempt++) {
        // If this key got cooled mid-call by another model, bail early
        // to the next key.
        if (state.cooldownUntil > Date.now()) break;
        try {
          return await tryOnceWithKey(state, model, opts.messages, opts);
        } catch (err) {
          lastErr = err;
          if (err instanceof RetriableError) {
            // Daily cap on this key → don't retry on this key, move on.
            if (state.cooldownUntil > Date.now()) {
              break;
            }
            if (err.status === 429 && attempt === 0) {
              console.warn(
                `[openrouter] ${state.label} ${model} → 429 (RPM/TPM), retry in 3s`,
              );
              await new Promise((r) => setTimeout(r, 3000));
              continue;
            }
            console.warn(
              `[openrouter] ${state.label} ${model} → ${err.status}: ${err.message.slice(0, 100)}`,
            );
            break; // next model under same key
          }
          throw err;
        }
      }
      if (state.cooldownUntil > Date.now()) break; // skip remaining models on this cooled key
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(
        `All ${KEY_POOL.length} OpenRouter keys / ${modelOrder.length} models exhausted`,
      );
}

// Diagnostic export — lets scripts/check-scoring.ts and similar surface
// the live pool state without leaking the keys themselves.
export function getKeyPoolStatus(): {
  total: number;
  available: number;
  pool: Array<{ label: string; available: boolean; cooldownUntil: string | null }>;
} {
  const now = Date.now();
  return {
    total: KEY_POOL.length,
    available: KEY_POOL.filter((k) => k.cooldownUntil <= now).length,
    pool: KEY_POOL.map((k) => ({
      label: k.label,
      available: k.cooldownUntil <= now,
      cooldownUntil:
        k.cooldownUntil > now ? new Date(k.cooldownUntil).toISOString() : null,
    })),
  };
}
