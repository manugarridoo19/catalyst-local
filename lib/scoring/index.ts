import { chatCompletion, getKeyPoolStatus } from "@/lib/providers/openrouter";
import {
  groqChatCompletion,
  GroqRateLimited,
  isGroqModelCooled,
} from "@/lib/providers/groq";
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  BATCH_SYSTEM_PROMPT,
  buildUserPrompt,
  buildBatchUserPrompt,
  type BatchPromptItem,
} from "./prompt";
import { parseScore, parseBatchScores } from "./parser";
import type { SentimentScore } from "@/lib/types";

// Stack de scoring:
//   1) OpenRouter Nemotron (nvidia/nemotron-3-super-120b-a12b:free) primario
//      — modelo big de NVIDIA con razonamiento más fino que Llama 3.1 8b
//   2) Groq llama-3.1-8b-instant como fallback rápido si OpenRouter cae
//   3) Si ambos fallan, dejamos sin score y el siguiente cron retry
//
// Si quieres forzar otro modelo: SCORER_PRIMARY=groq | openrouter

type Provider = "openrouter" | "groq";

// 2026-07: default de vuelta a OpenRouter. El motivo del cambio a Groq
// (2026-05) era latencia por-noticia con Vercel Hobby de por medio: 5-15s
// por call × 1 noticia. Con batch v4 (10 noticias/call, sin Vercel en el
// path) el coste amortizado es ~1s/noticia y la calidad de nemotron-ultra
// ≫ llama-3.1-8b (56% neutro perezoso en el audit de mayo). Groq queda de
// fallback. Override puntual: SCORER_PRIMARY=groq en env.
const PRIMARY: Provider =
  (process.env.SCORER_PRIMARY?.toLowerCase() as Provider) || "openrouter";

// 2026-07: la cadena de modelos de scoring vive en TASK_MODEL_CHAINS
// (lib/providers/openrouter.ts, task="scoring"). OPENROUTER_MODEL en env
// sigue funcionando como override — chatCompletion lo antepone él mismo.
async function scoreViaOpenRouter(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}) {
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: buildUserPrompt(input) },
  ];
  const result = await chatCompletion({
    messages,
    task: "scoring",
    temperature: 0.1,
    maxTokens: 220,
    jsonMode: true,
  });
  return { content: result.content, model: result.model };
}

// Stack interno de Groq: 70b versatile primary (31% neutro perezoso en
// audit) → 8b instant fallback (56% neutro pero TPM cap 30K, mucho más
// holgado que el 70b 12K). El 70b da mejor calidad sentiment+impact en
// los pocos calls que entran antes de TPM-saturar; el 8b absorbe el resto.
const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

async function scoreViaGroq(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}) {
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: buildUserPrompt(input) },
  ];
  let lastErr: unknown = null;
  for (const model of GROQ_MODELS) {
    // Cortocircuito por cooldown: si el provider ya parseó un Retry-After
    // anterior, no malgastamos un round-trip. Saltamos al siguiente modelo
    // (o al provider siguiente si todos están cooled).
    if (isGroqModelCooled(model)) {
      continue;
    }
    try {
      const result = await groqChatCompletion({
        messages,
        model,
        temperature: 0.1,
        maxTokens: 220,
        jsonMode: true,
        // 0 retries por modelo aquí — si 70b 429ea, saltamos a 8b inmediato.
        retries: 0,
      });
      return { content: result.content, model: result.model };
    } catch (err) {
      lastErr = err;
      if (err instanceof GroqRateLimited) {
        console.warn(`[scoring] groq ${model} rate-limited, trying next`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new GroqRateLimited("All Groq models cooled / failed");
}

export async function scoreNewsItem(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}): Promise<SentimentScore | null> {
  // OJO: el pool de OpenRouter tiene 3 fuentes (OPENROUTER_API_KEYS, archivo
  // off-repo, OPENROUTER_API_KEY legacy) — comprobar solo la env legacy
  // desactivaba el provider cuando únicamente existía el pool multi-key.
  const hasOpenRouter = getKeyPoolStatus().total > 0;
  const hasGroq = Boolean(process.env.GROQ_API_KEY);
  if (!hasOpenRouter && !hasGroq) {
    console.warn("[scoring] no provider keys set — skipping");
    return null;
  }

  // Orden de proveedores según preferencia.
  const order: Provider[] =
    PRIMARY === "groq" ? ["groq", "openrouter"] : ["openrouter", "groq"];

  for (const provider of order) {
    if (provider === "openrouter" && !hasOpenRouter) continue;
    if (provider === "groq" && !hasGroq) continue;

    // Cortocircuito: si TODAS las keys de OpenRouter están cooled, ni
    // intentamos. El provider tirará "All N keys cooled until HH:MMZ"
    // pero antes hacíamos parseo del error string y waste de stack.
    if (provider === "openrouter") {
      const pool = getKeyPoolStatus();
      if (pool.total > 0 && pool.available === 0) {
        console.warn(
          `[scoring] openrouter pool fully cooled (${pool.total} keys) — skipping`,
        );
        continue;
      }
    }
    // Cortocircuito groq: si los DOS modelos están en cooldown por
    // Retry-After, mismo tratamiento.
    if (provider === "groq") {
      if (GROQ_MODELS.every((m) => isGroqModelCooled(m))) {
        console.warn(`[scoring] groq all models in cooldown — skipping`);
        continue;
      }
    }

    try {
      const { content, model } =
        provider === "openrouter"
          ? await scoreViaOpenRouter(input)
          : await scoreViaGroq(input);
      const parsed = parseScore(content);
      if (!parsed) {
        console.warn(
          `[scoring] ${provider} unparseable: "${content.slice(0, 200).replace(/\n/g, " ")}"`,
        );
        continue; // intenta siguiente provider
      }
      return {
        impact: parsed.impact,
        sentiment: parsed.sentiment,
        category: parsed.category,
        rationale: parsed.rationale,
        model,
        promptVersion: PROMPT_VERSION,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof GroqRateLimited) {
        console.warn(`[scoring] groq rate-limited:`, msg.slice(0, 100));
      } else {
        console.warn(`[scoring] ${provider} error:`, msg.slice(0, 160));
      }
      // continúa al siguiente provider
    }
  }
  return null;
}

// ============================================================================
// Batch scoring (v4) — hasta BATCH_SIZE noticias en UNA llamada LLM.
// ============================================================================
//
// Por qué: con scoring 1-a-1, 3 keys OpenRouter × 1000 calls/día = 3.000
// noticias/día, por debajo del inflow (~2.000/día) + backlog (~31k). En
// lotes de 10, la misma cuota puntúa 30.000/día. Bonus: el modelo devuelve
// wrong_tickers por item — validación semántica de los links del extractor
// sin llamadas extra.

export const BATCH_SIZE = 10;

// Un lote genera ~10×90 tokens de output; los modelos free tardan más que
// los ~5s de una call single. Timeouts propios del modo batch.
const BATCH_MAX_TOKENS = 1400;
const OPENROUTER_BATCH_TIMEOUT_MS = 45_000;
const GROQ_BATCH_TIMEOUT_MS = 25_000;

export type BatchScoredItem = SentimentScore & {
  /** Tickers del item que el LLM marcó como no pertinentes (subset ya
   *  validado contra la lista de entrada del item). */
  wrongTickers: string[];
};

async function batchViaOpenRouter(items: BatchPromptItem[]) {
  const result = await chatCompletion({
    messages: [
      { role: "system", content: BATCH_SYSTEM_PROMPT },
      { role: "user", content: buildBatchUserPrompt(items) },
    ],
    task: "scoring",
    temperature: 0.1,
    maxTokens: BATCH_MAX_TOKENS,
    jsonMode: true,
    timeoutMs: OPENROUTER_BATCH_TIMEOUT_MS,
  });
  return { content: result.content, model: result.model };
}

async function batchViaGroq(items: BatchPromptItem[]) {
  const messages = [
    { role: "system" as const, content: BATCH_SYSTEM_PROMPT },
    { role: "user" as const, content: buildBatchUserPrompt(items) },
  ];
  let lastErr: unknown = null;
  for (const model of GROQ_MODELS) {
    if (isGroqModelCooled(model)) continue;
    try {
      const result = await groqChatCompletion({
        messages,
        model,
        temperature: 0.1,
        maxTokens: BATCH_MAX_TOKENS,
        jsonMode: true,
        retries: 0,
        timeoutMs: GROQ_BATCH_TIMEOUT_MS,
      });
      return { content: result.content, model: result.model };
    } catch (err) {
      lastErr = err;
      if (err instanceof GroqRateLimited) continue;
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new GroqRateLimited("All Groq models cooled / failed");
}

// Puntúa un lote. Devuelve un array alineado con `items`: score o null
// (item ausente/malformado en la respuesta → null, el caller reintenta en
// el siguiente tick). Si un provider devuelve un batch inparseable entero,
// cae al siguiente provider igual que scoreNewsItem.
export async function scoreNewsBatch(
  items: Array<{
    headline: string;
    body?: string;
    tickers: string[];
    source?: string;
  }>,
): Promise<Array<BatchScoredItem | null>> {
  if (!items.length) return [];
  const empty: Array<BatchScoredItem | null> = items.map(() => null);

  const hasOpenRouter = getKeyPoolStatus().total > 0;
  const hasGroq = Boolean(process.env.GROQ_API_KEY);
  if (!hasOpenRouter && !hasGroq) {
    console.warn("[scoring] no provider keys set — skipping batch");
    return empty;
  }

  const order: Provider[] =
    PRIMARY === "groq" ? ["groq", "openrouter"] : ["openrouter", "groq"];

  for (const provider of order) {
    if (provider === "openrouter" && !hasOpenRouter) continue;
    if (provider === "groq" && !hasGroq) continue;
    if (provider === "openrouter") {
      const pool = getKeyPoolStatus();
      if (pool.total > 0 && pool.available === 0) {
        console.warn(
          `[scoring] openrouter pool fully cooled (${pool.total} keys) — skipping batch`,
        );
        continue;
      }
    }
    if (provider === "groq" && GROQ_MODELS.every((m) => isGroqModelCooled(m))) {
      console.warn(`[scoring] groq all models in cooldown — skipping batch`);
      continue;
    }

    try {
      const { content, model } =
        provider === "openrouter"
          ? await batchViaOpenRouter(items)
          : await batchViaGroq(items);
      const parsed = parseBatchScores(content, items.length);
      if (!parsed.size) {
        console.warn(
          `[scoring] ${provider} batch unparseable: "${content.slice(0, 200).replace(/\n/g, " ")}"`,
        );
        continue; // siguiente provider
      }
      return items.map((item, i) => {
        const p = parsed.get(i + 1);
        if (!p) return null;
        const inputSet = new Set(item.tickers.map((t) => t.toUpperCase()));
        return {
          impact: p.impact,
          sentiment: p.sentiment,
          category: p.category,
          rationale: p.rationale,
          model,
          promptVersion: PROMPT_VERSION,
          // Nunca aceptar tickers que el modelo se haya inventado.
          wrongTickers: p.wrongTickers.filter((t) => inputSet.has(t)),
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[scoring] ${provider} batch error:`, msg.slice(0, 160));
      // continúa al siguiente provider
    }
  }
  return empty;
}
