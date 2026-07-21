// Embeddings de Google AI Studio para Ask Catalyst (RAG, Fase 2 2026-07-21).
//
// Comparte las keys del pool de gemini.ts pero NO su estado de cooldown: la
// cuota de embeddings es otra métrica (`embed_content_free_tier_requests`)
// y enfriar una key aquí por un 429 de embeddings dejaría al scorer sin esa
// key sin ninguna razón.
//
// Límites medidos empíricamente el 2026-07-21 (Google ya no los publica en
// los docs, remiten a AI Studio):
//   - 100 embeddings/minuto y key. OJO: en `batchEmbedContents` **cada
//     texto cuenta como una request**, no el batch entero (verificado: 66
//     sueltas + 1 batch de 100 → 429 con `limit: 100`). El batch ahorra
//     latencia y handshakes, nunca cuota.
//   - Máximo 100 textos por batch (400 INVALID_ARGUMENT por encima).
//   - Cuota diaria: ver EMBED_DAILY_NOTE abajo.
//
// Con outputDimensionality<3072 el vector NO viene normalizado (norma ~0.6):
// sólo la dimensión nativa lo está. Normalizamos aquí para que el coseno de
// pgvector no arrastre diferencias de escala y para que la conversión a
// halfvec (2 bytes/dim) use bien su rango.

import { listGeminiKeys, geminiDailyResetMs } from "@/lib/providers/gemini";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
export const EMBED_MODEL = "gemini-embedding-001";
export const EMBED_DIMS = 768;
/** Tope duro de la API. */
export const EMBED_MAX_BATCH = 100;

/** Un texto = una request de cuota; el batch sólo ahorra latencia. */
type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** Todas las keys están enfriadas: no es un fallo, es "vuelve luego". El
 *  caller (tick de embeddings) debe salir en silencio y reintentar en el
 *  siguiente tick, igual que score-orphans con la cuota LLM. */
export class EmbedQuotaError extends Error {
  constructor(public until: number) {
    super(`gemini embed quota exhausted until ${new Date(until).toISOString()}`);
    this.name = "EmbedQuotaError";
  }
}

const cooldown = new Map<string, number>();

function isCool(label: string): boolean {
  return (cooldown.get(label) ?? 0) <= Date.now();
}

/** Clasifica un 429. Google manda `retryDelay` en los límites por minuto;
 *  el diario llega sin él (o pidiendo esperar horas), y se enfría hasta el
 *  reset Pacific. Ante la duda, cooldown corto: perder un tick es barato,
 *  enfriar 12h una key sana no. */
function applyRateLimit(label: string, body: string): void {
  const m = body.match(/"retryDelay"\s*:\s*"(\d+)/) ?? body.match(/retry in (\d+)/i);
  const retrySec = m ? Number(m[1]) + 2 : 0;
  if (retrySec > 0 && retrySec <= 300) {
    cooldown.set(label, Date.now() + retrySec * 1000);
    console.warn(`[gemini-embed] ${label} RPM burst — cooled ${retrySec}s`);
    return;
  }
  cooldown.set(label, geminiDailyResetMs());
  console.warn(
    `[gemini-embed] ${label} DAILY QUOTA — cooled until ${new Date(geminiDailyResetMs()).toISOString().slice(0, 16)}Z`,
  );
}

function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return v;
  return v.map((x) => x / norm);
}

/** 401/403: la key no sirve (revocada, proyecto sin la API activada). No es
 *  transitorio, así que se aparta hasta el reset diario en vez de
 *  reintentarla en cada llamada — y se avisa fuerte, porque el
 *  skip-and-continue que impide que una key mala tumbe al proveedor es
 *  también lo que hace que una key muerta pase desapercibida. */
function applyAuthFailure(label: string): void {
  cooldown.set(label, geminiDailyResetMs());
  console.warn(
    `[gemini-embed] ${label} AUTH FAILED (401/403) — key inválida, apartada hasta el reset`,
  );
}

let rr = 0;

async function callWithKey(
  key: string,
  texts: string[],
  taskType: TaskType,
  timeoutMs: number,
): Promise<{ ok: true; vectors: number[][] } | { ok: false; status: number; body: string }> {
  const payload = {
    requests: texts.map((text) => ({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: EMBED_DIMS,
    })),
  };
  const res = await fetch(
    `${BASE}/models/${EMBED_MODEL}:batchEmbedContents`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) {
    return { ok: false, status: res.status, body: await res.text().catch(() => "") };
  }
  const json = (await res.json()) as {
    embeddings?: Array<{ values?: number[] }>;
  };
  const vectors = (json.embeddings ?? []).map((e) => e.values ?? []);
  if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBED_DIMS)) {
    // 200 con forma inesperada. Como el 200-vacío del scoring: tratarlo
    // como éxito corrompería la tabla con vectores mudos.
    return { ok: false, status: 502, body: `shape mismatch: ${vectors.length}/${texts.length}` };
  }
  return { ok: true, vectors: vectors.map(l2normalize) };
}

/**
 * Embebe hasta EMBED_MAX_BATCH textos en UNA llamada. El caller trocea.
 * Lanza EmbedQuotaError si ninguna key está disponible (reintento en el
 * siguiente tick), o el último error si todas fallaron por otra cosa.
 */
export async function embedBatch(
  texts: string[],
  opts: { taskType?: TaskType; timeoutMs?: number } = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > EMBED_MAX_BATCH) {
    throw new Error(`embedBatch: ${texts.length} > ${EMBED_MAX_BATCH} (la API rechaza el batch)`);
  }
  const keys = listGeminiKeys();
  if (keys.length === 0) throw new Error("No Gemini keys configured");
  const taskType = opts.taskType ?? "RETRIEVAL_DOCUMENT";
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // Igual que el pool de chat: primero las primarias en round-robin,
  // la reserva (cuenta principal del usuario) sólo si no queda otra.
  const primary = keys.filter((k) => !k.reserve);
  const reserve = keys.filter((k) => k.reserve);
  let lastErr: unknown = null;
  let anyAvailable = false;
  // ¿Todo lo que falló fue "esta key no está disponible" (cuota o auth)?
  // Entonces esto es un "vuelve luego", no un error del job: el caller debe
  // reintentar en el siguiente tick en vez de morirse. Un backfill entero
  // se cayó por dejar escapar el 401 de la key de reserva (2026-07-21).
  let onlyUnavailable = true;

  for (const [tier, rotate] of [
    [primary, true],
    [reserve, false],
  ] as const) {
    const base = rr;
    for (let i = 0; i < tier.length; i++) {
      const k = tier[rotate ? (base + i) % tier.length : i];
      if (!isCool(k.label)) continue;
      anyAvailable = true;
      if (rotate) rr = (base + i + 1) % tier.length;
      try {
        const r = await callWithKey(k.key, texts, taskType, timeoutMs);
        if (r.ok) return r.vectors;
        if (r.status === 429) applyRateLimit(k.label, r.body);
        else if (r.status === 401 || r.status === 403) applyAuthFailure(k.label);
        else onlyUnavailable = false;
        lastErr = new Error(`gemini-embed ${k.label} ${r.status}: ${r.body.slice(0, 140)}`);
      } catch (err) {
        // Skip-and-continue en cualquier fallo per-key (mismo criterio que
        // gemini.ts): un error duro no debe wedgear el tier entero.
        onlyUnavailable = false;
        lastErr = err;
      }
    }
  }

  if (!anyAvailable || onlyUnavailable) {
    const untils = keys
      .map((k) => cooldown.get(k.label) ?? 0)
      .filter((t) => t > Date.now());
    throw new EmbedQuotaError(untils.length ? Math.min(...untils) : Date.now());
  }
  throw lastErr instanceof Error ? lastErr : new Error("gemini-embed: all keys failed");
}

/** Estado del pool de embeddings (para /api/health y scripts). */
export function getEmbedPoolStatus(): {
  total: number;
  available: number;
  pool: Array<{ label: string; available: boolean; cooldownUntil: string | null }>;
} {
  const keys = listGeminiKeys();
  const now = Date.now();
  return {
    total: keys.length,
    available: keys.filter((k) => (cooldown.get(k.label) ?? 0) <= now).length,
    pool: keys.map((k) => {
      const until = cooldown.get(k.label) ?? 0;
      return {
        label: k.label,
        available: until <= now,
        cooldownUntil: until > now ? new Date(until).toISOString() : null,
      };
    }),
  };
}
