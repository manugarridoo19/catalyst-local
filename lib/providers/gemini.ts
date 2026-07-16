// Cliente para Google AI Studio (Gemini API) con pool de keys. Tercer
// proveedor del stack (2026-07-16): entra cuando el pool de OpenRouter se
// agota (free-models-per-day) y antes de Groq, para que el proyecto siga
// puntuando/escribiendo sin romper el flujo.
//
// Diseño del pool — "una sola key que aguanta más": a diferencia del pool
// de OpenRouter (secuencial: se agota una key → pasa a la siguiente,
// porque su límite dominante es diario), aquí el límite que muerde primero
// es el RPM por proyecto. Por eso la rotación es ROUND-ROBIN: cada request
// sale por una key distinta, así N keys ≈ N× el RPM efectivo y las cuotas
// diarias se consumen en paralelo y por igual, sin solaparse.
//
// Modelo: gemini-3.1-flash-lite — el tier "lite" es el de mayor cuota
// free (el 2.5-flash-lite que lo inauguró ya no está disponible para
// cuentas nuevas; 3.1 es su sucesor estable). Fallback in-provider:
// gemini-2.0-flash-lite.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatMessage,
  ChatCompletionResult,
} from "@/lib/providers/openrouter";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_MODELS = ["gemini-3.1-flash-lite", "gemini-2.0-flash-lite"];

// Off-repo secrets file, mismo patrón que ~/.catalyst-openrouter-keys
// (los settings del usuario deniegan tocar ./.env*). Formato: una línea
// GEMINI_API_KEYS=k1,k2,k3. En GH Actions y en el Worker la env var llega
// por secrets, así que el archivo solo hace falta en el Mac.
const LOCAL_KEYS_FILE = join(homedir(), ".catalyst-gemini-keys");

function readKeysFromLocalFile(): string {
  if (!existsSync(LOCAL_KEYS_FILE)) return "";
  try {
    const raw = readFileSync(LOCAL_KEYS_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^GEMINI_API_KEYS\s*=\s*(.+)$/);
      if (m) return m[1].trim();
    }
    return "";
  } catch {
    return "";
  }
}

type KeyState = {
  key: string;
  /** ms epoch; 0 = disponible. */
  cooldownUntil: number;
  label: string;
};

function loadKeyPool(): KeyState[] {
  const fromMulti = (process.env.GEMINI_API_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromFile = readKeysFromLocalFile()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromSingle = [(process.env.GEMINI_API_KEY ?? "").trim()].filter(
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
  return raw.map((key, i) => ({ key, cooldownUntil: 0, label: `g${i + 1}` }));
}

const KEY_POOL: KeyState[] = loadKeyPool();

// Cursor del round-robin. Avanza en cada request para que peticiones
// consecutivas salgan por keys distintas (reparte el RPM del pool).
let rrCursor = 0;

function maskKey(k: string): string {
  if (k.length < 12) return "***";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// Las cuotas diarias free de Google resetean a medianoche PACIFIC (07:00
// UTC en verano, PDT) — no a medianoche UTC como OpenRouter. Enfriamos
// hasta las 07:05Z del día siguiente que toque, con margen.
function nextPacificMidnightMs(): number {
  const now = new Date();
  const todayReset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    7,
    5,
  );
  return now.getTime() < todayReset
    ? todayReset
    : todayReset + 24 * 3600_000;
}

class GeminiRetriable extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Parsea el body de un 429 de Google: cuota diaria (enfriar la key hasta
 *  el reset Pacific) vs burst por-minuto (cooldown corto, respetando el
 *  RetryInfo.retryDelay que manda la API si viene). */
function applyRateLimit(state: KeyState, bodyText: string): void {
  if (/perday|per_day|daily/i.test(bodyText)) {
    state.cooldownUntil = nextPacificMidnightMs();
    console.warn(
      `[gemini] ${state.label} ${maskKey(state.key)} HIT DAILY QUOTA — cooled until ${new Date(state.cooldownUntil).toISOString().slice(0, 16)}Z`,
    );
    return;
  }
  const m = bodyText.match(/"retryDelay"\s*:\s*"(\d+)/);
  const retrySec = m ? Math.min(Number(m[1]) + 2, 300) : 60;
  state.cooldownUntil = Date.now() + retrySec * 1000;
  console.warn(
    `[gemini] ${state.label} RPM burst — cooled ${retrySec}s`,
  );
}

function toGeminiPayload(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
): Record<string, unknown> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.2,
    maxOutputTokens: opts.maxTokens ?? 256,
    // flash-lite puede razonar si se lo dejan puesto — mismo problema que
    // Nemotron en OpenRouter (quema el output budget en pensamiento).
    // Presupuesto 0 = thinking off.
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (opts.jsonMode) generationConfig.responseMimeType = "application/json";
  const payload: Record<string, unknown> = { contents, generationConfig };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  return payload;
}

async function tryOnceWithKey(
  state: KeyState,
  model: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ChatCompletionResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": state.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GeminiRetriable(`timeout ${timeoutMs}ms on ${model}`, 408);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429) applyRateLimit(state, text);
    if ([404, 408, 429, 500, 502, 503].includes(res.status)) {
      throw new GeminiRetriable(
        `${res.status} ${res.statusText}: ${text.slice(0, 120)}`,
        res.status,
      );
    }
    throw new Error(
      `Gemini ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  const content = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");
  return {
    content,
    model,
    usage: json.usageMetadata
      ? {
          prompt_tokens: json.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: json.usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: json.usageMetadata.totalTokenCount ?? 0,
        }
      : undefined,
  };
}

// Interfaz espejo de chatCompletion (openrouter.ts) para que los callers
// puedan encadenar proveedores sin adaptar shapes.
export async function geminiChatCompletion(opts: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}): Promise<ChatCompletionResult> {
  if (KEY_POOL.length === 0) {
    throw new Error(
      "No Gemini keys configured — set GEMINI_API_KEYS or GEMINI_API_KEY",
    );
  }
  const payload = toGeminiPayload(opts.messages, opts);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const models = opts.model
    ? [opts.model, ...GEMINI_MODELS.filter((m) => m !== opts.model)]
    : GEMINI_MODELS;

  let lastErr: unknown = null;
  for (const model of models) {
    // Una vuelta completa al pool por modelo, arrancando en el cursor
    // round-robin (peticiones consecutivas salen por keys distintas).
    for (let i = 0; i < KEY_POOL.length; i++) {
      const state = KEY_POOL[(rrCursor + i) % KEY_POOL.length];
      if (state.cooldownUntil > Date.now()) continue;
      try {
        const result = await tryOnceWithKey(state, model, payload, timeoutMs);
        rrCursor = (rrCursor + i + 1) % KEY_POOL.length;
        return result;
      } catch (err) {
        lastErr = err;
        if (err instanceof GeminiRetriable) continue; // siguiente key
        throw err;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(
        `All ${KEY_POOL.length} Gemini keys / ${models.length} models exhausted`,
      );
}

export function getGeminiPoolStatus(): {
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
