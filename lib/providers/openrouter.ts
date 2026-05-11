// Cliente fino para OpenRouter (chat completions). Lo usamos para scoring
// de sentimiento/impacto. Implementa fallback entre modelos `:free` porque
// los providers upstream se rate-limitean a menudo.

const BASE = "https://openrouter.ai/api/v1";

// 2026-05: solo dejamos los modelos VERIFICADOS disponibles via REST. Probé
// DeepSeek V3.1, Nemotron 70B, Qwen 2.5 72B, Gemini 2.0 — todos devuelven
// 404 "No endpoints found". Lo que queda activo en free es bastante poco.
// Si openrouter/owl-alpha 429s, cae a Llama 3.3 70B; si esa también, el
// outer fallback en scoring/index.ts pasa el control a Groq.
const DEFAULT_MODEL_FALLBACKS = [
  "meta-llama/llama-3.3-70b-instruct:free",
];

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
  ) {
    super(message);
  }
}

// Timeout por intento. owl-alpha tiene worker pool pequeño y excess requests
// quedan en cola hasta 90-120s — sin esto una sola llamada lenta tumba el
// cron de 60s entero. 15s da margen para una call típica (~5s) + variance.
const PER_REQUEST_TIMEOUT_MS = 15000;

async function tryOnce(
  model: string,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
): Promise<ChatCompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 256,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://catalyst-local.local",
        "X-Title": "Catalyst Local",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RetriableError(`timeout ${PER_REQUEST_TIMEOUT_MS}ms on ${model}`, 408);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 404 (modelo retirado), 408 (timeout cliente), 429 (rate limit),
    // 502/503 → probar siguiente.
    if (
      res.status === 404 ||
      res.status === 408 ||
      res.status === 429 ||
      res.status === 502 ||
      res.status === 503
    ) {
      throw new RetriableError(`${res.status} ${res.statusText}: ${text.slice(0, 120)}`, res.status);
    }
    throw new Error(`OpenRouter ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
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
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<ChatCompletionResult> {
  // Construir orden de modelos: primero el explícito (si lo hay), luego los
  // fallbacks excluyendo duplicados.
  const preferred = opts.model || process.env.OPENROUTER_MODEL;
  const order = [
    ...(preferred ? [preferred] : []),
    ...DEFAULT_MODEL_FALLBACKS.filter((m) => m !== preferred),
  ];

  let lastErr: unknown = null;
  for (const model of order) {
    // Hasta 2 reintentos por modelo con backoff lineal — owl-alpha tiene
    // burst tight pero se libera en 2-5s. No vale para 429 sostenido.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await tryOnce(model, opts.messages, opts);
      } catch (err) {
        lastErr = err;
        if (err instanceof RetriableError) {
          if (err.status === 429 && attempt === 0) {
            console.warn(`[openrouter] ${model} → 429, retry in 3s`);
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          console.warn(`[openrouter] ${model} → ${err.status}: ${err.message.slice(0, 100)}`);
          break; // intenta siguiente modelo
        }
        throw err;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("All OpenRouter free models rate-limited");
}
