// Cliente fino para OpenRouter (chat completions). Lo usamos para scoring
// de sentimiento/impacto. Implementa fallback entre modelos `:free` porque
// los providers upstream se rate-limitean a menudo.

const BASE = "https://openrouter.ai/api/v1";

// Orden de fallback. El primero es OPENROUTER_MODEL si está fijado, y si
// no, este orden por defecto (más rápido → más lento).
const DEFAULT_MODEL_FALLBACKS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-nemo:free",
  "qwen/qwen-2.5-7b-instruct:free",
  "google/gemma-2-9b-it:free",
  "meta-llama/llama-3.2-3b-instruct:free",
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

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://catalyst-local.local",
      "X-Title": "Catalyst Local",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 429 (rate limit) y 502/503 son retriables — probar otro modelo.
    if (res.status === 429 || res.status === 502 || res.status === 503) {
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
    try {
      return await tryOnce(model, opts.messages, opts);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof RetriableError)) throw err;
      // Probar siguiente modelo.
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("All OpenRouter free models rate-limited");
}
