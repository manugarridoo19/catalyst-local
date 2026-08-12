"use client";

import { useState } from "react";
import Link from "next/link";
import { CornerDownLeft, Loader2 } from "lucide-react";
import type { AskResponse } from "@/app/api/ask/route";

// Panel de Ask Catalyst. Cliente porque es un formulario con estado; toda
// la inteligencia vive en /api/ask (retrieval + gating de cuota).
//
// La UI tiene una obligación editorial: dejar claro que lo que se lee sale
// DEL ARCHIVO y es verificable. Por eso las citas se numeran igual que en
// el texto y cada una enlaza a su fuente original.

const EXAMPLES = [
  "¿Qué se dijo de NVDA esta semana?",
  "¿Dejo correr $MSFT o vendo una parte?",
  "What are insiders buying lately?",
  "¿Hay algún 13D nuevo?",
];

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function money(n: number): string {
  return `${Math.round(n).toLocaleString("es-ES")}$`;
}

const SIDE_LABEL: Record<string, string> = {
  add: "a favor de ampliar",
  hold: "a favor de aguantar",
  trim: "a favor de recortar",
  neutral: "importa, no inclina",
};

const SIDE_TONE: Record<string, string> = {
  add: "text-sky-700 dark:text-sky-300",
  hold: "text-emerald-700 dark:text-emerald-300",
  trim: "text-amber-700 dark:text-amber-300",
  neutral: "text-muted-foreground",
};

function sentimentTone(n: number): string {
  if (n >= 2) return "text-emerald-700 dark:text-emerald-300";
  if (n <= -2) return "text-rose-700 dark:text-rose-300";
  return "text-muted-foreground";
}

type Turn = { question: string; answer: string; symbols: string[] };

/** Texto plano de una respuesta para el historial: la prosa si existe, si
 *  no las secciones unidas. El servidor lo recorta igualmente. */
function plainAnswer(r: AskResponse): string {
  if (r.answer) return r.answer;
  return r.sections
    .map((s) => (s.title ? `${s.title}: ${s.text}` : s.text))
    .join(" · ");
}

export function AskPanel() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<AskResponse | null>(null);
  // Turnos previos de ESTA conversación. Viajan con cada pregunta para que
  // "¿y a largo plazo?" tenga referente; el servidor los usa como contexto
  // y para heredar símbolos, nunca como fuente de hechos.
  const [history, setHistory] = useState<Turn[]>([]);

  async function submit(q: string) {
    const trimmed = q.trim();
    if (trimmed.length < 3 || loading) return;
    setLoading(true);
    setRes(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, history }),
      });
      const data = (await r.json()) as AskResponse;
      setRes(data);
      // Solo las respuestas REDACTADAS entran al historial: un resultado de
      // búsqueda léxica no es un turno de conversación que retomar.
      if (data.mode === "answer" && (data.answer || data.sections.length)) {
        setHistory((h) =>
          [
            ...h,
            {
              question: trimmed,
              answer: plainAnswer(data).slice(0, 700),
              symbols: data.symbols ?? [],
            },
          ].slice(-3),
        );
      }
      setQuestion("");
    } catch {
      setRes(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(question);
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center gap-2 rounded-sm border border-border/60 bg-card/50 px-3 py-2 focus-within:border-primary/50">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
            Ask
          </span>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={300}
            placeholder="¿Qué se dijo de NVDA esta semana?"
            className="flex-1 bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/40"
            aria-label="Pregunta sobre el archivo"
          />
          <button
            type="submit"
            disabled={loading || question.trim().length < 3}
            className="flex items-center gap-1.5 rounded-sm border border-border/60 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-40"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CornerDownLeft className="h-3 w-3" />
            )}
            {loading ? "Buscando" : "Preguntar"}
          </button>
        </div>
        {history.length > 0 ? (
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/60"
              title={history.map((t) => t.question).join("\n")}
            >
              Conversación · {history.length}{" "}
              {history.length === 1 ? "turno" : "turnos"} · seguimiento de:{" "}
              &ldquo;{history[history.length - 1].question}&rdquo;
            </span>
            <button
              type="button"
              onClick={() => {
                setHistory([]);
                setRes(null);
              }}
              className="shrink-0 rounded-sm border border-border/40 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/70 transition-colors hover:border-primary/40 hover:text-primary"
            >
              Nueva conversación
            </button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setQuestion(ex);
                void submit(ex);
              }}
              className="rounded-sm border border-border/40 px-2 py-1 font-mono text-[10px] text-muted-foreground/70 transition-colors hover:border-primary/40 hover:text-primary"
            >
              {ex}
            </button>
          ))}
        </div>
      </form>

      {res ? <Answer res={res} /> : null}
    </div>
  );
}

/**
 * Exposición, presiones y calendario de una pregunta de decisión.
 *
 * Se pinta APARTE de la prosa y no dentro de ella por la misma razón que la
 * revisión de cartera devuelve el libro de futuros fuera de la reseña: son
 * los datos que sostienen la postura, salen de SQL y son verdad aunque el
 * redactor haya fallado o la cadena de fallback haya contestado con el
 * modelo de la cola. Si el LLM cae, esto sigue respondiendo media pregunta.
 */
function DecisionBlocks({ res }: { res: AskResponse }) {
  const held = res.position.filter((p) => p.held);
  const sides = (["add", "hold", "trim", "neutral"] as const).map((side) => ({
    side,
    items: res.pressures.filter((p) => p.side === side),
  }));
  const hasAny =
    held.length || res.pressures.length || res.dated.length || res.ledger.length;
  if (!hasAny) return null;

  return (
    <section className="flex flex-col gap-3">
      {held.length ? (
        <div>
          <h2 className="eyebrow mb-2 text-[10px] text-foreground">
            Tu exposición
          </h2>
          <div className="grid gap-2 md:grid-cols-2">
            {held.map((p) => (
              <div
                key={p.symbol}
                className="rounded-sm border border-border/50 bg-card/30 px-3 py-2 font-mono text-[11px]"
              >
                <div className="flex items-baseline justify-between">
                  <Link
                    href={`/ticker/${p.symbol}`}
                    className="text-foreground hover:text-primary"
                  >
                    {p.symbol}
                  </Link>
                  {p.weightPct !== null ? (
                    <span className="text-[10px] text-muted-foreground/70">
                      {p.weightPct.toFixed(1)}% de la cartera
                    </span>
                  ) : null}
                </div>
                <dl className="mt-1.5 space-y-0.5 text-[10.5px] text-muted-foreground">
                  {p.marketValue !== null ? (
                    <div className="flex justify-between gap-3">
                      <dt>valor</dt>
                      <dd className="text-foreground/80">{money(p.marketValue)}</dd>
                    </div>
                  ) : null}
                  {p.unrealizedPct !== null ? (
                    <div className="flex justify-between gap-3">
                      <dt>P&amp;L no realizado</dt>
                      <dd
                        className={
                          p.unrealizedPct >= 0
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-rose-700 dark:text-rose-300"
                        }
                      >
                        {pct(p.unrealizedPct)}
                        {p.unrealizedAbs !== null ? ` · ${money(p.unrealizedAbs)}` : ""}
                      </dd>
                    </div>
                  ) : null}
                  {p.avgCost !== null ? (
                    <div className="flex justify-between gap-3">
                      <dt>coste medio</dt>
                      <dd className="text-foreground/80">{p.avgCost}$</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {res.pressures.length ? (
        <div>
          <div className="mb-2 flex items-baseline gap-2.5">
            <h2 className="eyebrow text-[10px] text-foreground">Presiones</h2>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
              hechos duros · el lado lo asigna el código, no el modelo
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {sides
              .filter((s) => s.items.length)
              .map((s) => (
                <div key={s.side}>
                  <h3
                    className={`eyebrow mb-1 text-[9px] ${SIDE_TONE[s.side]}`}
                  >
                    {SIDE_LABEL[s.side]}
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {s.items.map((p, i) => (
                      <li
                        key={`${p.symbol}-${i}`}
                        className="rounded-sm border border-border/40 bg-card/25 px-3 py-1.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground"
                      >
                        <span className="text-foreground/80">{p.symbol}</span>{" "}
                        {p.text}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </div>
      ) : null}

      {res.ledger.length ? (
        <div>
          <div className="mb-2 flex items-baseline gap-2.5">
            <h2 className="eyebrow text-[10px] text-foreground">
              Compromisos sin resolver
            </h2>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
              extraído del cuerpo de los artículos — lo que no ves en tu bróker
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {res.ledger.map((i, idx) => (
              <li
                key={`${i.symbol}-${idx}`}
                className="rounded-sm border border-border/40 bg-card/25 px-3 py-1.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground"
              >
                <span className="text-foreground/80">{i.symbol}</span>{" "}
                <span className="text-foreground/70">{i.event}</span>
                {i.when || i.whenDate ? (
                  <span className="text-primary/70"> · {i.whenDate ?? i.when}</span>
                ) : null}
                {i.condition ? (
                  <span className="text-amber-700/80 dark:text-amber-300/80">
                    {" "}
                    · sujeto a {i.condition}
                  </span>
                ) : null}
                <span className="text-muted-foreground/50"> [{i.source}]</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {res.dated.length ? (
        <div>
          <div className="mb-2 flex items-baseline gap-2.5">
            <h2 className="eyebrow text-[10px] text-foreground">
              Lo que ya está fechado
            </h2>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
              publicado o comprometido — aquí no hay ninguna previsión
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {res.dated.map((d, i) => (
              <li
                key={`${d.symbol}-${i}`}
                className="flex gap-2.5 rounded-sm border border-border/40 bg-card/25 px-3 py-1.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground"
              >
                <span className="shrink-0 text-primary/70">
                  {d.date ?? "s/f"}
                </span>
                <span>
                  <span className="text-foreground/80">{d.symbol}</span> {d.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Answer({ res }: { res: AskResponse }) {
  // "No hay cobertura" y un bloque de presiones debajo se contradicen. En
  // una decisión con hechos duros el archivo SÍ sabe algo: lo que falta es
  // la prosa, y eso ya lo dice `note`.
  const hasHardDecision =
    res.job === "decision" &&
    (res.pressures.length > 0 || res.dated.length > 0 || res.ledger.length > 0);
  const noCoverage = res.coverage === "none" && !res.answer && !hasHardDecision;

  return (
    <div className="flex flex-col gap-5">
      {res.note ? (
        <p className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
          {res.note}
        </p>
      ) : null}

      {noCoverage ? (
        <div className="rounded-sm border border-border/60 bg-card/40 px-4 py-6 text-center">
          <p className="font-mono text-[12px] text-muted-foreground">
            No hay cobertura de esto en el archivo.
          </p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
            Catalyst responde sólo con lo que ha ingerido y puntuado — no
            rellena con conocimiento del modelo.
          </p>
        </div>
      ) : null}

      {res.answer ? (
        <div className="rounded-sm border border-border/60 bg-card/40 px-4 py-3">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="eyebrow text-[10px] text-foreground">Answer</span>
            {res.coverage === "partial" ? (
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
                cobertura parcial
              </span>
            ) : null}
          </div>
          {/* Con epígrafes cuando el material dio para ellos; si no, el
              párrafo de siempre. La forma la decide el servidor (mirando el
              retrieval), no esta vista: aquí sólo se pinta lo que vino. */}
          {res.sections?.length ? (
            <div className="flex flex-col gap-3">
              {res.sections.map((s, i) =>
                // La postura no es una sección más: es la respuesta a la
                // pregunta y el resto es el porqué. Si se pinta igual que
                // "lo que no sé", el lector vuelve a tener que buscarla.
                s.key === "stance" ? (
                  <div
                    key={`${s.key}-${i}`}
                    className="border-l-2 border-primary/60 pl-3"
                  >
                    {s.title ? (
                      <h3 className="eyebrow mb-1 text-[9.5px] text-primary/80">
                        {s.title}
                      </h3>
                    ) : null}
                    <p className="font-editorial text-[15px] leading-relaxed text-foreground">
                      {s.text}
                    </p>
                  </div>
                ) : (
                  <div key={`${s.key}-${i}`}>
                    {s.title ? (
                      <h3 className="eyebrow mb-1 text-[9.5px] text-muted-foreground">
                        {s.title}
                      </h3>
                    ) : null}
                    <p className="font-editorial text-[13.5px] leading-relaxed text-foreground/90">
                      {s.text}
                    </p>
                  </div>
                ),
              )}
            </div>
          ) : (
            <p className="font-editorial text-[13.5px] leading-relaxed text-foreground/90">
              {res.answer}
            </p>
          )}
          {res.model ? (
            <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/40">
              {res.model}
            </p>
          ) : null}
        </div>
      ) : null}

      {res.job === "decision" ? <DecisionBlocks res={res} /> : null}

      {res.facts.length ? (
        <section>
          <h2 className="eyebrow mb-2 text-[10px] text-foreground">
            Computed facts
          </h2>
          <div className="grid gap-2 md:grid-cols-2">
            {res.facts.map((f) => (
              <div
                key={f.symbol}
                className="rounded-sm border border-border/50 bg-card/30 px-3 py-2 font-mono text-[11px]"
              >
                <div className="flex items-baseline justify-between">
                  <Link
                    href={`/ticker/${f.symbol}`}
                    className="text-foreground hover:text-primary"
                  >
                    {f.symbol}
                  </Link>
                  <span className="text-[10px] text-muted-foreground/60">
                    {f.newsCount7d} items · 7d
                  </span>
                </div>
                <dl className="mt-1.5 space-y-0.5 text-[10.5px] text-muted-foreground">
                  {f.avgSentiment7d !== null ? (
                    <div className="flex justify-between gap-3">
                      <dt>avg sentiment 7d</dt>
                      <dd className={sentimentTone(f.avgSentiment7d)}>
                        {f.avgSentiment7d.toFixed(2)}
                      </dd>
                    </div>
                  ) : null}
                  {f.insiderNet30d ? (
                    <div className="flex justify-between gap-3">
                      <dt>insider net 30d</dt>
                      <dd
                        className={
                          f.insiderNet30d > 0
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-rose-700 dark:text-rose-300"
                        }
                      >
                        ${Math.round(f.insiderNet30d).toLocaleString("en-US")}
                      </dd>
                    </div>
                  ) : null}
                  {f.nextEarnings ? (
                    <div className="flex justify-between gap-3">
                      <dt>next earnings</dt>
                      <dd className="text-foreground/80">{f.nextEarnings}</dd>
                    </div>
                  ) : null}
                  {f.stakes.map((s) => (
                    <div key={s.filedAt + (s.filer ?? "")} className="flex justify-between gap-3">
                      <dt className="truncate">13D/G {s.filer ?? "—"}</dt>
                      <dd className="text-foreground/80">
                        {s.pct !== null ? `${s.pct}%` : "—"} · {s.filedAt}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {res.citations.length ? (
        <section>
          <div className="mb-2 flex items-baseline gap-2.5">
            <h2 className="eyebrow text-[10px] text-foreground">
              {res.mode === "answer" ? "Sources" : "Archive matches"}
            </h2>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
              {res.mode === "answer"
                ? "cada afirmación sale de aquí"
                : "búsqueda por texto — la respuesta IA es sólo para la sesión del dueño"}
            </span>
          </div>
          <ol className="flex flex-col gap-1.5">
            {res.citations.map((c) => (
              <li
                key={c.n}
                className="flex gap-2.5 rounded-sm border border-border/40 bg-card/25 px-3 py-2"
              >
                <span className="font-mono text-[11px] text-primary/80">
                  [{c.n}]
                </span>
                <div className="min-w-0 flex-1">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-editorial text-[13px] leading-snug text-foreground/90 hover:text-primary"
                  >
                    {c.headline}
                  </a>
                  {c.summary ? (
                    <p className="mt-0.5 line-clamp-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
                      {c.summary}
                    </p>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/55">
                    <span>{c.publishedAt.slice(0, 10)}</span>
                    <span>·</span>
                    <span>{c.source}</span>
                    {c.symbols.length ? (
                      <>
                        <span>·</span>
                        <span className="text-muted-foreground/80">
                          {c.symbols.join(" ")}
                        </span>
                      </>
                    ) : null}
                    <span>·</span>
                    <span className="text-muted-foreground/40">{c.via}</span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
