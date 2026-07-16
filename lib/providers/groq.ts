// Cliente para Groq Cloud — modelos Llama free con rate-limit muy
// generoso (30 req/min en free tier) y latencia sub-segundo. Usado como
// scorer primario porque OpenRouter free está saturado upstream.

const BASE = "https://api.groq.com/openai/v1";

// 8b vs 70b: 70b sigue la regla anti-neutro mejor PERO el TPM cap free
// del 70b es ~12K/min — con prompts ~800 tokens nos satura a los 15 calls
// y el cron entero cae a 429 cascade. 8b tiene 30K TPM, scoring estable.
// Tradeoff aceptable: ~5% de los casos perdemos la dirección correcta.
const DEFAULT_MODEL = "llama-3.1-8b-instant";

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

export class GroqRateLimited extends Error {
  /** ms epoch hasta el que el modelo está agotado (parsed from Retry-After).
   *  null si Groq no envió el header. */
  retryAtMs: number | null;
  constructor(message: string, retryAtMs: number | null = null) {
    super(message);
    this.name = "GroqRateLimited";
    this.retryAtMs = retryAtMs;
  }
}

// Cooldown módulo-level por modelo. Cuando Groq devuelve 429 con
// Retry-After=N, marcamos ese modelo como agotado hasta now+N segundos.
// El siguiente intento al mismo modelo cortocircuita sin tocar la red,
// ahorrando ~300-800ms y una unidad de cuota burst (Groq cuenta los
// requests rechazados igualmente para algunos windows). El cooldown vive
// dentro del proceso — daemon local lo mantiene siempre, GH Actions
// runner lo pierde al terminar el tick (aceptable: cada tick es nuevo).
const modelCooldownUntil = new Map<string, number>();

export function isGroqModelCooled(model: string): boolean {
  const until = modelCooldownUntil.get(model);
  return until !== undefined && until > Date.now();
}

export function groqCooldownStatus(): Array<{ model: string; secondsRemaining: number }> {
  const now = Date.now();
  const out: Array<{ model: string; secondsRemaining: number }> = [];
  for (const [model, until] of modelCooldownUntil.entries()) {
    if (until > now) out.push({ model, secondsRemaining: Math.ceil((until - now) / 1000) });
  }
  return out;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  // RFC 7231: o bien segundos enteros, o bien HTTP-date.
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Date.now() + Math.ceil(asSeconds * 1000);
  }
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return asDate;
  return null;
}

// Timeout por intento. Groq normalmente <2s pero rate-limit + cola interna
// pueden colgar la conexión 60s+. Sin esto, un solo call lento tumba el
// cron de 60s antes de que pueda hacer fallback a OpenRouter.
const PER_REQUEST_TIMEOUT_MS = 8000;

async function groqOnce(
  apiKey: string,
  model: string,
  opts: {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    timeoutMs?: number;
  },
): Promise<ChatCompletionResult> {
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? 200,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  const timeoutMs = opts.timeoutMs ?? PER_REQUEST_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Groq timeout ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429) {
      const retryAtMs = parseRetryAfter(res.headers.get("retry-after"));
      if (retryAtMs) {
        modelCooldownUntil.set(model, retryAtMs);
      }
      throw new GroqRateLimited(`Groq 429: ${text.slice(0, 120)}`, retryAtMs);
    }
    throw new Error(`Groq ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
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

export async function groqChatCompletion(opts: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  retries?: number;
  timeoutMs?: number;
}): Promise<ChatCompletionResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const model = opts.model || process.env.GROQ_MODEL || DEFAULT_MODEL;
  const maxRetries = opts.retries ?? 3;

  // Cortocircuito: si el modelo está en cooldown (parsed Retry-After) lo
  // declaramos rate-limited inmediatamente. Ahorra fetch + ~1 burst-unit
  // por intento.
  if (isGroqModelCooled(model)) {
    const remaining = (modelCooldownUntil.get(model)! - Date.now()) / 1000;
    throw new GroqRateLimited(
      `Groq model ${model} cooled for ${remaining.toFixed(1)}s`,
      modelCooldownUntil.get(model)!,
    );
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await groqOnce(apiKey, model, opts);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof GroqRateLimited) || attempt === maxRetries) {
        throw err;
      }
      // Si Groq dio Retry-After, esperar ese tiempo exacto (capado a 30s
      // para no bloquear el cron). Si no, backoff exponencial 2/4/8s.
      let wait: number;
      if (err.retryAtMs) {
        const delta = err.retryAtMs - Date.now();
        wait = Math.min(30_000, Math.max(500, delta));
      } else {
        wait = 2000 * Math.pow(2, attempt);
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Groq retries exhausted");
}
