// Cliente para Groq Cloud — modelos Llama free con rate-limit muy
// generoso (30 req/min en free tier) y latencia sub-segundo. Usado como
// scorer primario porque OpenRouter free está saturado upstream.

const BASE = "https://api.groq.com/openai/v1";

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
  constructor(message: string) {
    super(message);
    this.name = "GroqRateLimited";
  }
}

export async function groqChatCompletion(opts: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<ChatCompletionResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const model = opts.model || process.env.GROQ_MODEL || DEFAULT_MODEL;

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? 200,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new GroqRateLimited(`Groq 429: ${text.slice(0, 120)}`);
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
