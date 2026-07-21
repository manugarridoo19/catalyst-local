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
  "What are insiders buying lately?",
  "¿Hay algún 13D nuevo?",
];

function sentimentTone(n: number): string {
  if (n >= 2) return "text-emerald-700 dark:text-emerald-300";
  if (n <= -2) return "text-rose-700 dark:text-rose-300";
  return "text-muted-foreground";
}

export function AskPanel() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<AskResponse | null>(null);

  async function submit(q: string) {
    const trimmed = q.trim();
    if (trimmed.length < 3 || loading) return;
    setLoading(true);
    setRes(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      setRes((await r.json()) as AskResponse);
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

function Answer({ res }: { res: AskResponse }) {
  const noCoverage = res.coverage === "none" && !res.answer;

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
          <p className="font-editorial text-[13.5px] leading-relaxed text-foreground/90">
            {res.answer}
          </p>
          {res.model ? (
            <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/40">
              {res.model}
            </p>
          ) : null}
        </div>
      ) : null}

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
