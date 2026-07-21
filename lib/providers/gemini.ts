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
// Modelo: gemini-3.5-flash-lite — el tier "lite" es el de mayor cuota
// free (el 2.5-flash-lite que lo inauguró ya no está disponible para
// cuentas nuevas; 3.5 es el sucesor vigente, 2026-07-21). Fallback
// in-provider: gemini-3.1-flash-lite.
//
// El fallback NO es gemini-2.0-flash-lite desde 2026-07-21: su free tier
// está a cero (una sola request viola a la vez las cuotas por-día Y las
// por-minuto en las 4 keys — sólo pasa si el límite es 0). Y un fallback
// muerto no era neutro, era ACTIVAMENTE tóxico: su 429 lleva quotaId
// `...PerDay...`, que `applyRateLimit` interpretaba como cuota diaria de
// la KEY ENTERA y la enfriaba hasta medianoche Pacific — aunque la cuota
// agotada fuese sólo la de ESE modelo. Como el bucle de modelos es el
// externo, un bache pasajero en el modelo de cabeza barría los 2.0 detrás
// y dejaba todas las keys (incluida la de reserva) muertas el resto del día.
// Desde entonces el cooldown de cuota tiene dimensión de MODELO (las cuotas
// free de Google son `…PerProjectPerModel`): agotar 3.5 en una key ya no
// quema 3.1 en esa key. Un modelo sin cuota en GEMINI_MODELS sigue siendo
// mala idea (regala una request muerta por sweep), pero ya no envenena.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatMessage,
  ChatCompletionResult,
} from "@/lib/providers/openrouter";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

// Off-repo secrets file, mismo patrón que ~/.catalyst-openrouter-keys
// (los settings del usuario deniegan tocar ./.env*). Formato:
//   GEMINI_API_KEYS=k1,k2,k3          → pool primario (round-robin normal)
//   GEMINI_RESERVE_API_KEYS=kMain     → reserva (solo si el primario agotó)
// En GH Actions y el Worker las env vars llegan por secrets, así que el
// archivo solo hace falta en el Mac.
const LOCAL_KEYS_FILE = join(homedir(), ".catalyst-gemini-keys");

function readLocalVar(name: string): string {
  if (!existsSync(LOCAL_KEYS_FILE)) return "";
  try {
    const raw = readFileSync(LOCAL_KEYS_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(new RegExp(`^${name}\\s*=\\s*(.+)$`));
      if (m) return m[1].trim();
    }
    return "";
  } catch {
    return "";
  }
}

type KeyState = {
  key: string;
  /** ms epoch; 0 = disponible. Cooldown de la KEY completa — solo para
   *  cuotas cuyo quotaId NO lleva dimensión de modelo. */
  cooldownUntil: number;
  /** ms epoch por modelo. Las cuotas free de Google son
   *  `…PerProjectPerModel`: agotar la diaria de 3.5 en esta key no dice
   *  NADA de la de 3.1 en esta key — enfriar la key entera tiraba esa
   *  capacidad hasta medianoche Pacific (pendiente del audit 2026-07-21). */
  modelCooldowns: Map<string, number>;
  label: string;
  /** Reserva: cuenta principal del usuario, blindada. Solo se usa cuando
   *  NINGUNA key primaria está disponible. Uso mínimo = perfil casi humano
   *  = mínima superficie de detección multi-cuenta para la cuenta que menos
   *  queremos perder. */
  reserve: boolean;
};

function splitKeys(...sources: string[]): string[] {
  const out: string[] = [];
  for (const src of sources) {
    for (const k of src.split(",").map((s) => s.trim()).filter(Boolean)) {
      out.push(k);
    }
  }
  return out;
}

function loadKeyPool(): KeyState[] {
  const primary = splitKeys(
    process.env.GEMINI_API_KEYS ?? "",
    readLocalVar("GEMINI_API_KEYS"),
    (process.env.GEMINI_API_KEY ?? "").trim(), // legacy single-key
  );
  const reserve = splitKeys(
    process.env.GEMINI_RESERVE_API_KEYS ?? "",
    readLocalVar("GEMINI_RESERVE_API_KEYS"),
  );

  const seen = new Set<string>();
  const pool: KeyState[] = [];
  let i = 0;
  // Primarias primero. Una key que aparezca en ambas listas queda como
  // primaria (dedupe por key exacta) — pero el usuario debe mantener la
  // main SOLO en la lista de reserva para que quede blindada.
  for (const key of primary) {
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({
      key,
      cooldownUntil: 0,
      modelCooldowns: new Map(),
      label: `g${++i}`,
      reserve: false,
    });
  }
  for (const key of reserve) {
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({
      key,
      cooldownUntil: 0,
      modelCooldowns: new Map(),
      label: `gR${++i}`,
      reserve: true,
    });
  }
  return pool;
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

/** Parsea el body de un 429 de Google y enfría el ÁMBITO correcto.
 *
 *  - MÉTRICA por `details[].violations[].quotaId`, el campo AUTORITATIVO
 *    (mismo patrón que gemini-embed.ts): el diario también llega pidiendo
 *    "retry in 2.35s", así que el tamaño del retryDelay no clasifica nada.
 *    Sin quotaId, se cae al regex legacy sobre el body.
 *  - ÁMBITO: las cuotas free son `…PerProjectPerModel` → cooldown por
 *    (key, modelo); solo un quotaId explícito SIN `PerModel` enfría la key
 *    completa. Sin quotaId también se enfría solo el modelo: si el problema
 *    fuese de la key entera, el siguiente modelo cosecha su propio 429 y
 *    cae igual (cuesta 1 request), mientras que el error inverso —enfriar
 *    la key por la cuota de UN modelo— tira hasta medianoche Pacific la
 *    capacidad de los demás (el envenenamiento del 2.0-flash-lite). */
function applyRateLimit(
  state: KeyState,
  model: string,
  bodyText: string,
): void {
  const quotaId = bodyText.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1] ?? "";
  const daily = quotaId
    ? /PerDay/i.test(quotaId)
    : /perday|per_day|daily/i.test(bodyText);
  const wholeKey = quotaId !== "" && !/PerModel/i.test(quotaId);

  let until: number;
  let what: string;
  if (daily) {
    until = nextPacificMidnightMs();
    what = `DAILY QUOTA (${quotaId || "sin quotaId"}) — cooled until ${new Date(until).toISOString().slice(0, 16)}Z`;
  } else {
    const m = bodyText.match(/"retryDelay"\s*:\s*"(\d+)/);
    const retrySec = m ? Math.min(Number(m[1]) + 2, 300) : 60;
    until = Date.now() + retrySec * 1000;
    what = `RPM burst — cooled ${retrySec}s`;
  }
  if (wholeKey) {
    state.cooldownUntil = until;
    console.warn(
      `[gemini] ${state.label} ${maskKey(state.key)} WHOLE KEY ${what}`,
    );
  } else {
    state.modelCooldowns.set(model, until);
    console.warn(
      `[gemini] ${state.label} ${maskKey(state.key)} [${model}] ${what}`,
    );
  }
}

/** ¿Puede esta key intentar ESTE modelo ahora? (cooldown de key y de
 *  (key, modelo) expirados). */
function keyUsableFor(state: KeyState, model: string, now: number): boolean {
  return (
    state.cooldownUntil <= now &&
    (state.modelCooldowns.get(model) ?? 0) <= now
  );
}

// El control de "no pienses" cambió de dialecto en Gemini 3.x: `thinkingBudget`
// (numérico) sólo lo entienden 2.x/2.5, y 3.x exige el enum `thinkingLevel`.
// Mandarle `thinkingBudget:0` a un 3.x devuelve 400 INVALID_ARGUMENT — y 400 NO
// está en la lista de retriables, así que tumbaría el modelo de cabeza en TODAS
// las keys (verificado a mano contra la API el 2026-07-21). `minimal` es el
// nivel más bajo del enum: "none" no existe. Misma intención que budget 0.
// Por eso el payload se construye POR MODELO y no una vez para toda la cadena:
// el fallback mezcla familias y cada una habla su dialecto.
function thinkingConfigFor(model: string): Record<string, unknown> {
  return model.startsWith("gemini-3")
    ? { thinkingLevel: "minimal" }
    : { thinkingBudget: 0 };
}

function toGeminiPayload(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
  model: string,
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
    // Thinking al mínimo que permita la familia del modelo.
    thinkingConfig: thinkingConfigFor(model),
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
    if (res.status === 429) applyRateLimit(state, model, text);
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
  if (content.trim() === "") {
    // 200 con contenido vacío (finishReason MAX_TOKENS/SAFETY sin texto).
    // Devolverlo como éxito cortocircuita la cadena de fallback.
    throw new GeminiRetriable(`empty content from ${model}`, 502);
  }
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
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const models = opts.model
    ? [opts.model, ...GEMINI_MODELS.filter((m) => m !== opts.model)]
    : GEMINI_MODELS;

  // Blindaje de la cuenta principal: intentamos PRIMERO todas las keys
  // primarias; la(s) de reserva solo entran si ninguna primaria respondió.
  // Así la main hace el mínimo de llamadas posibles (perfil casi humano).
  const primary = KEY_POOL.filter((k) => !k.reserve);
  const reserve = KEY_POOL.filter((k) => k.reserve);

  let lastErr: unknown = null;

  // El round-robin (rrCursor) solo rota sobre las primarias; la reserva se
  // recorre en orden fijo y sin avanzar el cursor (queremos que su uso sea
  // esporádico, no parte de la rotación).
  async function tryTier(
    keys: KeyState[],
    rotate: boolean,
  ): Promise<ChatCompletionResult | null> {
    // Cursor base estable durante el sweep; rrCursor se actualiza tras CADA
    // intento (éxito o fallo) — antes solo avanzaba en éxito, y una key que
    // fallara duro (400 revocada) se quedaba en cabeza y se reintentaba la
    // primera en cada request.
    const base = rrCursor;
    for (const model of models) {
      // Por modelo, no por request: cada familia quiere su thinkingConfig.
      const payload = toGeminiPayload(opts.messages, opts, model);
      for (let i = 0; i < keys.length; i++) {
        const idx = rotate ? (base + i) % keys.length : i;
        const state = keys[idx];
        if (!keyUsableFor(state, model, Date.now())) continue;
        if (rotate) rrCursor = (base + i + 1) % keys.length;
        try {
          const result = await tryOnceWithKey(state, model, payload, timeoutMs);
          return result;
        } catch (err) {
          // SKIP-and-continue en CUALQUIER fallo per-key, no solo los
          // GeminiRetriable. Un error duro (400 API_KEY_INVALID, 403, reset
          // de red, body malformado) NO debe abortar el resto de keys ni el
          // tier de reserva — si de verdad es fatal para todas, sale por el
          // throw final. Antes, un error no-listado con el cursor parado en
          // una key mala dejaba todo el proveedor muerto hasta reinicio.
          lastErr = err;
          continue;
        }
      }
    }
    return null;
  }

  const viaPrimary = primary.length ? await tryTier(primary, true) : null;
  if (viaPrimary) return viaPrimary;

  if (reserve.length) {
    console.warn(
      "[gemini] primary pool exhausted — using RESERVE (main account) key",
    );
    const viaReserve = await tryTier(reserve, false);
    if (viaReserve) return viaReserve;
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(
        `All ${KEY_POOL.length} Gemini keys / ${models.length} models exhausted`,
      );
}

/** Las keys del pool, para proveedores hermanos que hablan con otra API de
 *  Google con su PROPIA cuota (gemini-embed.ts). Comparten cuenta y por
 *  tanto keys, pero NO estado de cooldown: un 429 de embeddings no dice
 *  nada sobre la cuota de generateContent y enfriarla aquí dejaría al
 *  scorer sin esa key gratis. Nunca se serializa fuera del proceso. */
export function listGeminiKeys(): Array<{
  key: string;
  label: string;
  reserve: boolean;
}> {
  return KEY_POOL.map((k) => ({
    key: k.key,
    label: k.label,
    reserve: k.reserve,
  }));
}

/** Medianoche Pacific siguiente, en ms — el reset de las cuotas diarias de
 *  Google (no es medianoche UTC). Compartido con gemini-embed.ts. */
export function geminiDailyResetMs(): number {
  return nextPacificMidnightMs();
}

export function getGeminiPoolStatus(): {
  total: number;
  available: number;
  primary: number;
  reserve: number;
  pool: Array<{
    label: string;
    reserve: boolean;
    available: boolean;
    cooldownUntil: string | null;
    cooledModels: Record<string, string>;
  }>;
} {
  const now = Date.now();
  // "Disponible" = puede intentar AL MENOS un modelo de la cadena. Una key
  // con 3.5 agotado pero 3.1 vivo sigue siendo capacidad real.
  const usable = (k: KeyState) =>
    GEMINI_MODELS.some((m) => keyUsableFor(k, m, now));
  return {
    total: KEY_POOL.length,
    available: KEY_POOL.filter(usable).length,
    primary: KEY_POOL.filter((k) => !k.reserve).length,
    reserve: KEY_POOL.filter((k) => k.reserve).length,
    pool: KEY_POOL.map((k) => ({
      label: k.label,
      reserve: k.reserve,
      available: usable(k),
      cooldownUntil:
        k.cooldownUntil > now ? new Date(k.cooldownUntil).toISOString() : null,
      cooledModels: Object.fromEntries(
        [...k.modelCooldowns]
          .filter(([, t]) => t > now)
          .map(([m, t]) => [m, new Date(t).toISOString()]),
      ),
    })),
  };
}
