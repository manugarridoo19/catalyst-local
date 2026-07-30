import { proseCompletion } from "@/lib/ai/prose-chain";
import { FRAME_SPEC, type Attribution, type Frame } from "@/lib/coach/frames";

// Los dos usos de LLM del coach: proponer falsadores y comprobar si se han
// cumplido. Ninguno de los dos CONCLUYE nada por su cuenta — el primero
// redacta candidatos que el usuario tiene que aprobar, y el segundo sólo
// puede contestar sí/no citando el documento.

// ─── Proponer ────────────────────────────────────────────────────────────

const PROPOSE_PROMPT = `You help an investor make their own thesis falsifiable.

They have written, in their own words, why they hold a position. Your job is
NOT to judge the thesis, agree with it, or improve it. It is to name the
concrete, observable things that would show it was WRONG — the pre-mortem
question: "what would have to happen for me to be mistaken?"

Return STRICT JSON: {"falsifiers": ["...", "...", "..."]}

Two to four items. Each one must be:

- OBSERVABLE in a quarterly earnings release. "The company loses its edge" is
  useless; "core advertising revenue grows less than 10% year over year for
  two consecutive quarters" is checkable.
- SPECIFIC to this thesis and this kind of company. You are told which frame
  the investor declared. For a company deliberately spending to build
  something, heavy capex is the THESIS, not a falsifier — proposing it would
  be proposing that they are wrong for being right. What falsifies that kind
  of thesis is the part that funds the bet failing, or the bet consuming more
  while returning nothing for long enough.
- A FAILURE, not a fluctuation. One soft quarter is noise. Say how much, for
  how long, or against what baseline.
- Written in the investor's language: Spanish, second person, one sentence,
  max 180 characters, no jargon they did not use themselves.

Do not propose price movements. A falling share price is not evidence that a
thesis is wrong — it is the situation in which the thesis is being tested.

Do not hedge. Each item must be something that either happened or did not.`;

export type ProposedFalsifiers = { falsifiers: string[] };

/**
 * Propone falsadores para una tesis. Devuelve [] si el modelo falla: no
 * tener candidatos es un estado normal y no debe romper el panel.
 */
export async function proposeFalsifiers(input: {
  symbol: string;
  frame: Frame;
  thesis: string;
  /** Lo último que reportó la empresa. Se pasa para que los falsadores usen
   *  las MAGNITUDES REALES del negocio en vez de porcentajes inventados: sin
   *  esto, el modelo propone "si el margen cae por debajo del 20%" sobre una
   *  empresa cuyo margen es del 45%, y ese falsador no se cumple nunca. */
  attributions: Attribution[];
}): Promise<string[]> {
  const spec = FRAME_SPEC[input.frame];
  const contexto = input.attributions.length
    ? input.attributions
        .map((a) => `- ${a.magnitude} [${a.layer}]`)
        .join("\n")
    : "(no hay comunicado reciente con cifras)";

  const user = [
    `Symbol: ${input.symbol}`,
    `Declared frame: ${spec.label} — ${spec.hint}`,
    `For this frame, "the core" means: ${spec.core}`,
    ``,
    `The investor's thesis, verbatim:`,
    `"""${input.thesis}"""`,
    ``,
    `What the company most recently reported:`,
    contexto,
  ].join("\n");

  try {
    const res = await proseCompletion({
      messages: [
        { role: "system", content: PROPOSE_PROMPT },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      maxTokens: 600,
      jsonMode: true,
      tag: "coach-falsifiers",
    });
    const parsed = JSON.parse(
      res.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    ) as unknown;
    const raw = (parsed as ProposedFalsifiers)?.falsifiers;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((f): f is string => typeof f === "string" && f.trim().length > 8)
      .map((f) => f.trim().slice(0, 180))
      .slice(0, 4);
  } catch (err) {
    console.warn(
      "[coach] proposeFalsifiers falló:",
      err instanceof Error ? err.message.slice(0, 140) : err,
    );
    return [];
  }
}

// ─── Comprobar ───────────────────────────────────────────────────────────

// El prompt más delicado del proyecto, porque es el único cuya salida
// AFIRMA. Todo en él está inclinado hacia el "no": un falso negativo cuesta
// un trimestre de retraso, un falso positivo le dice al usuario que su tesis
// está rota cuando no lo está — y eso, sobre dinero, se paga una sola vez.
const CHECK_PROMPT = `You check whether a specific, pre-declared condition occurred, according to a company's own earnings release.

The investor wrote these conditions BEFORE knowing the outcome. Each states
something that, if it happened, means their investment thesis was wrong.

Return STRICT JSON:
{"results": [{"index": 0, "occurred": false, "evidence": null}]}

One entry per condition, same order, same count.

"occurred": true ONLY when the document shows the condition is met, plainly
and without arithmetic you had to invent. Otherwise false.

"evidence": when true, the VERBATIM sentence or figure from the document that
shows it. A true with no quotable evidence is invalid — return false instead.

DEFAULT TO FALSE. These are the cases that must return false:
- The document does not cover the metric at all.
- It is close to the threshold but does not cross it.
- The condition needs two consecutive quarters and you only have one.
- It requires data the release does not print.
- You are unsure.

"I cannot tell from this document" is FALSE, not true. A condition that has
not been shown to occur has not occurred, as far as you are concerned.

Do not interpret the spirit of the condition, only its letter. Do not judge
whether the thesis is good. Do not consider the share price. Use ONLY the
document you are given — no outside knowledge about the company.`;

export type FalsifierCheck = {
  index: number;
  occurred: boolean;
  evidence: string | null;
};

/**
 * Comprueba una tanda de falsadores contra UN comunicado.
 *
 * Devuelve `[]` ante cualquier fallo, y eso es lo correcto: si no se ha
 * podido comprobar, lo que NO se puede hacer es dar por buena la ausencia
 * de alarma escribiendo `occurred: false` en la base de datos. Sin
 * resultado, la fila se queda sin evaluar y se reintenta.
 */
export async function checkFalsifiers(input: {
  symbol: string;
  conditions: string[];
  /** El texto del comunicado ya extraído, más su resumen y atribución. Se
   *  manda el DOCUMENTO y no sólo el resumen porque una condición sobre una
   *  cifra concreta casi nunca aparece en tres bullets. */
  document: string;
}): Promise<FalsifierCheck[]> {
  if (!input.conditions.length) return [];

  const user = [
    `Company: ${input.symbol}`,
    ``,
    `Conditions to check:`,
    ...input.conditions.map((c, i) => `${i}. ${c}`),
    ``,
    `The company's earnings release:`,
    input.document,
  ].join("\n");

  try {
    const res = await proseCompletion({
      messages: [
        { role: "system", content: CHECK_PROMPT },
        { role: "user", content: user },
      ],
      // Temperatura mínima: esto no es redacción, es una comprobación, y la
      // variabilidad aquí se traduce en que el mismo comunicado dispare un
      // falsador un día y no al siguiente.
      temperature: 0,
      maxTokens: 700,
      jsonMode: true,
      tag: "coach-check",
    });
    const parsed = JSON.parse(
      res.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    ) as { results?: unknown };
    if (!Array.isArray(parsed.results)) return [];

    const out: FalsifierCheck[] = [];
    for (const r of parsed.results) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const index = typeof o.index === "number" ? o.index : NaN;
      if (!Number.isInteger(index) || index < 0 || index >= input.conditions.length) {
        continue;
      }
      const evidence =
        typeof o.evidence === "string" && o.evidence.trim()
          ? o.evidence.trim().slice(0, 400)
          : null;
      // LA GUARDA QUE IMPORTA: un `occurred: true` sin cita se degrada a
      // false. El modelo puede convencerse de que algo pasó; lo que no puede
      // es inventarse una frase que esté en el documento y sobrevivir a que
      // el usuario la lea. Sin evidencia no hay veredicto duro.
      const occurred = o.occurred === true && evidence !== null;
      out.push({ index, occurred, evidence: occurred ? evidence : null });
    }
    return out;
  } catch (err) {
    console.warn(
      "[coach] checkFalsifiers falló:",
      err instanceof Error ? err.message.slice(0, 140) : err,
    );
    return [];
  }
}
