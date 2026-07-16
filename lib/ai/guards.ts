// Guards compartidos para prosa LLM user-facing (AI Brief global y Ticker
// Day Brief). Ambos generadores usan modelos reasoning-híbridos con
// reasoning:{enabled:false}; si aun así el modelo cuela scratchpad en la
// respuesta, mejor NO publicar y conservar el contenido anterior
// (post-mortem sueño-de-elvira 2026-05-21).

export function looksLikeScratchpad(content: string): boolean {
  return /\b(the user|I need to|I should|As an AI|let me|make sure to)\b/i.test(
    content.slice(0, 300),
  );
}

// Quita fences de código que algunos modelos envuelven alrededor del
// markdown pese a pedir "no code fences".
export function cleanModelProse(raw: string): string {
  return raw
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}
