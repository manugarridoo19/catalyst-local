"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CoachResponse } from "@/app/api/coach/route";
import type { PositionContrast } from "@/lib/coach/build";
import type { Falsifier } from "@/lib/coach/falsifiers";
import { cn } from "@/lib/utils";

// El panel del coach. Enseña, por posición: lo que TÚ escribiste, lo que se
// ha movido, a qué lo atribuye la empresa, y qué significa eso DADO el
// marco que declaraste.
//
// Lo que deliberadamente NO tiene es un veredicto. No hay semáforo global
// ni un "tu tesis está en riesgo". El caso que gobierna el diseño es el de
// META: márgenes cayendo 12 puntos porque la empresa está comprando
// infraestructura de IA. Cualquier conclusión automática ahí acierta a
// medias, y un coach que acierta a medias sobre dinero se deja de leer. Lo
// que sí hace, y ningún humano puede hacerse a sí mismo, es ponerte tus
// propias palabras al lado de los hechos sin dejarte reescribirlas después.

const SEVERITY_STYLE: Record<string, string> = {
  mortal: "border-rose-600/40 text-rose-700 dark:text-rose-300",
  vigilar: "border-amber-600/40 text-amber-700 dark:text-amber-300",
  esperado: "border-emerald-600/40 text-emerald-700 dark:text-emerald-300",
  confirma: "border-sky-600/40 text-sky-700 dark:text-sky-300",
};

export function CoachPanel() {
  const [data, setData] = useState<CoachResponse | null>(null);
  const [falsifiers, setFalsifiers] = useState<Falsifier[]>([]);
  // Arranca en `true` en vez de llamar a setLoading dentro del efecto: el
  // fetch sale en el primer render, así que "cargando" es el estado inicial
  // real y no una transición.
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/coach", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as CoachResponse;
        if (!cancelled) setData(j);
      })
      .catch(() => {
        if (!cancelled) setErr("No se pudo cargar el coach");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Los falsadores van en su propia petición: son escritura del usuario y
    // se refrescan al aprobar/rechazar, mientras que el contraste sólo
    // cambia cuando llega un comunicado nuevo. Unirlos obligaría a recargar
    // todo el panel por cada clic.
    fetch("/api/coach/falsifiers", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return;
        const j = (await r.json()) as { falsifiers: Falsifier[] };
        if (!cancelled) setFalsifiers(j.falsifiers ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading && !data) {
    return (
      <p className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground/60">
        <Loader2 className="h-3 w-3 animate-spin" /> leyendo tu cartera…
      </p>
    );
  }
  if (err) {
    return (
      <p className="font-mono text-[10.5px] text-rose-700 dark:text-rose-300">
        {err}
      </p>
    );
  }
  if (!data || !data.positions.length) return null;

  const legible = data.positions.filter((p) => p.readings.length > 0);
  const pendientes = data.positions.filter((p) => p.missing.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {legible.length === 0 ? (
        <p className="font-mono text-[10.5px] leading-relaxed text-muted-foreground/60">
          Todavía no hay nada que contrastar. El coach habla cuando una de
          tus posiciones publica resultados y tú has declarado qué clase de
          empresa crees que es.
        </p>
      ) : null}

      {legible.map((p) => (
        <PositionCard
          key={p.symbol}
          p={p}
          falsifiers={falsifiers}
          onFalsifiers={setFalsifiers}
        />
      ))}

      {pendientes.length ? (
        <div className="rounded-sm border border-border/50 bg-background/40 px-3 py-2">
          <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/50">
            lo que le falta al coach
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {pendientes.map((p) => (
              <li
                key={p.symbol}
                className="font-mono text-[10.5px] text-muted-foreground"
              >
                <span className="text-foreground/80">{p.symbol}</span>{" "}
                <span className="text-muted-foreground/60">
                  {/* Se enumera lo que falta y NO se rellena con supuestos:
                      sin marco, la misma señal se lee al revés. */}
                  {p.missing
                    .map((m) =>
                      m === "marco"
                        ? "sin marco declarado"
                        : m === "tesis"
                          ? "sin tesis escrita"
                          : "sin resultados publicados aún",
                    )
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * El rastro del marco: cuándo se declaró la vara con la que se juzga todo
 * lo de abajo, y qué decía antes.
 *
 * ESTO ES LO QUE CIERRA EL AGUJERO. El marco no es una etiqueta decorativa:
 * `readingOf()` lo toma como entrada, así que moverlo re-juzga hacia atrás
 * todas las lecturas de la tarjeta. Sin esta línea, reclasificar una
 * posición después de un mal trimestre convierte sus `mortal` en `esperado`
 * y el panel dice "esto es lo que compraste" sin que nada recuerde que
 * antes decía lo contrario. Es el mismo problema que «anotada a posteriori»
 * resuelve para la tesis.
 *
 * El ámbar se reserva para lo que de verdad contamina la lectura —el
 * cambio es POSTERIOR al comunicado o a la tesis que se están leyendo con
 * él—. Un cambio anterior a ambos se registra en gris: es historia, no
 * sesgo, y pintarlo todo de ámbar enseña a ignorar el color.
 */
function FrameTrail({ p }: { p: PositionContrast }) {
  if (!p.frameSetAt) return null;
  // Sin marco vigente no hay nada que contaminar: la posición está sin
  // clasificar y `missing` ya lo dice más arriba y más claro.
  if (!p.axes) return null;

  const reclasificada = p.framePrev !== null;
  const sesgado = p.frameChangedAfterReport || p.frameChangedAfterThesis;

  return (
    <p className="mt-0.5 font-mono text-[9.5px] leading-relaxed text-muted-foreground/45">
      {reclasificada
        ? `perfil cambiado ${p.frameSetAt} · antes: ${p.framePrevLabel}`
        : `clasificada ${p.frameSetAt}`}
      {sesgado ? (
        <span className="text-amber-700/80 dark:text-amber-300/80">
          {" · "}
          {/* Se nombra la fecha contra la que es posterior, no un genérico:
              «posterior a resultados 29-07» se puede comprobar, «posterior»
              a secas hay que creérselo. */}
          {p.frameChangedAfterReport
            ? `posterior a resultados ${p.reportDate}`
            : `posterior a la tesis ${p.thesisAt}`}
        </span>
      ) : null}
    </p>
  );
}

function PositionCard({
  p,
  falsifiers,
  onFalsifiers,
}: {
  p: PositionContrast;
  falsifiers: Falsifier[];
  onFalsifiers: (f: Falsifier[]) => void;
}) {
  return (
    <div className="rounded-sm border border-border/60 bg-card/40 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[12px] font-bold text-foreground">
          {p.symbol}
        </span>
        {p.frameLabel ? (
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/60">
            {p.frameLabel}
          </span>
        ) : null}
        {p.reportDate ? (
          <span className="ml-auto font-mono text-[9.5px] text-muted-foreground/45">
            resultados {p.reportDate}
          </span>
        ) : null}
      </div>

      <FrameTrail p={p} />

      {p.thesis ? (
        <div className="mt-1.5 border-l-2 border-border/60 pl-2">
          <p className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/50">
            lo que escribiste{p.thesisAt ? ` · ${p.thesisAt}` : ""}
            {p.thesisHorizon ? ` · ${p.thesisHorizon}` : ""}
            {/* La marca viaja hasta aquí a propósito: una tesis redactada
                sabiendo el resultado no es una predicción, y el panel no
                puede presentarla como si lo fuera. */}
            {p.thesisAnnotatedLater ? (
              <span className="text-amber-700/70 dark:text-amber-300/70">
                {" "}
                · anotada a posteriori
              </span>
            ) : null}
          </p>
          <p className="font-editorial text-[12px] leading-snug text-foreground/85">
            «{p.thesis}»
          </p>
        </div>
      ) : null}

      <ul className="mt-2 flex flex-col gap-1.5">
        {p.readings.map((r, i) => (
          <li key={i} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span
                className={cn(
                  "rounded-sm border px-1 py-px font-mono text-[9px] uppercase tracking-[0.12em]",
                  SEVERITY_STYLE[r.severity ?? ""] ??
                    "border-border/40 text-muted-foreground/60",
                )}
              >
                {r.severity ?? "sin lectura"}
              </span>
              <span className="font-mono text-[10.5px] text-foreground/80">
                {r.attribution.magnitude}
              </span>
            </div>
            {/* Sin marco, TODAS las lecturas de la tarjeta dicen lo mismo y
                repetirlo por línea lo convierte en ruido. La explicación
                sube una vez al pie de la tarjeta. */}
            {p.axes ? (
              <p className="pl-1 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
                {r.note}
              </p>
            ) : null}
            {r.attribution.quote ? (
              <p className="pl-1 font-editorial text-[11px] leading-snug text-muted-foreground/60">
                La empresa: «{r.attribution.quote}»
              </p>
            ) : (
              // Sin cita, la capa es una LECTURA del modelo y no una
              // declaración de la empresa. Decirlo es lo que separa un dato
              // verificable de una inferencia con la misma pinta.
              <p className="pl-1 font-mono text-[9.5px] text-muted-foreground/45">
                el comunicado no lo atribuye: la capa es inferida, no
                declarada
              </p>
            )}
          </li>
        ))}
      </ul>

      <Falsifiers
        symbol={p.symbol}
        canPropose={!!p.axes && !!p.thesis}
        items={falsifiers.filter((f) => f.symbol === p.symbol)}
        onChange={onFalsifiers}
      />

      {p.core ? (
        <p className="mt-2 border-t border-border/40 pt-1.5 font-mono text-[9.5px] leading-relaxed text-muted-foreground/50">
          lo que pondría en duda esta tesis: {p.core}
        </p>
      ) : (
        <p className="mt-2 border-t border-border/40 pt-1.5 font-mono text-[9.5px] leading-relaxed text-amber-700/70 dark:text-amber-300/70">
          Se ha movido algo, pero sin marco declarado no se puede leer si te
          contradice: el mismo capex es la tesis funcionando en una power
          play y una tesis rota en un compounder. Decláralo en la tabla de
          arriba.
        </p>
      )}
    </div>
  );
}

/**
 * Los falsadores de una posición: lo único que puede hacer que el coach
 * AFIRME que una tesis está rota.
 *
 * Los propone el modelo y los aprueba el usuario, y ese orden es todo el
 * diseño. Pedirlos en frío empobrece la tesis —una convicción real es un
 * cómputo de muchas cosas y reducirla a tres métricas la traiciona—, pero
 * dejar que el modelo los dé por buenos convertiría su criterio en el del
 * usuario. Proponer es barato; aprobar es lo que los hace suyos.
 *
 * Un falsador CUMPLIDO es el único sitio del panel donde aparece un
 * veredicto. Y ni siquiera ahí opina el coach: cita la condición que
 * escribiste antes de saber nada, con la frase del comunicado al lado.
 */
function Falsifiers({
  symbol,
  canPropose,
  items,
  onChange,
}: {
  symbol: string;
  canPropose: boolean;
  items: Falsifier[];
  onChange: (f: Falsifier[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const aprobados = items.filter((f) => f.status === "aprobado");
  const pendientes = items.filter((f) => f.status === "pendiente");
  const cumplidos = aprobados.filter((f) => f.trippedAt !== null);

  async function post(body: unknown, onFail: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/coach/falsifiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as {
        falsifiers?: Falsifier[];
      };
      if (!r.ok || !data.falsifiers) {
        setErr(onFail);
        return;
      }
      onChange(data.falsifiers);
    } catch {
      setErr("Error de red");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 border-t border-border/40 pt-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/50">
          qué te haría estar equivocado
        </span>
        {canPropose ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void post({ propose: { symbol } }, "No se pudieron proponer")
            }
            className="rounded-sm border border-border/50 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : pendientes.length || aprobados.length ? (
              "proponer otros"
            ) : (
              "proponer"
            )}
          </button>
        ) : null}
      </div>

      {err ? (
        <p className="mt-1 font-mono text-[9.5px] text-rose-700 dark:text-rose-300">
          {err}
        </p>
      ) : null}

      {/* Lo cumplido va PRIMERO y es lo único con veredicto en todo el panel. */}
      {cumplidos.map((f) => (
        <div
          key={f.id}
          className="mt-1.5 rounded-sm border border-rose-600/40 bg-rose-500/[0.04] px-2 py-1.5"
        >
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-rose-700 dark:text-rose-300">
            se ha cumplido · {f.trippedAt}
          </p>
          <p className="font-editorial text-[11.5px] leading-snug text-foreground/85">
            «{f.text}»
          </p>
          {f.trippedEvidence ? (
            <p className="mt-0.5 font-editorial text-[11px] leading-snug text-muted-foreground/70">
              La empresa: «{f.trippedEvidence}»
            </p>
          ) : null}
        </div>
      ))}

      {aprobados
        .filter((f) => f.trippedAt === null)
        .map((f) => (
          <p
            key={f.id}
            className="mt-1 font-mono text-[10px] leading-relaxed text-muted-foreground/70"
          >
            <span className="text-muted-foreground/40">vigilando · </span>
            {f.text}
          </p>
        ))}

      {pendientes.length ? (
        <div className="mt-1.5 flex flex-col gap-1">
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-amber-700/70 dark:text-amber-300/70">
            propuestos — no vigilan nada hasta que los apruebes
          </p>
          {pendientes.map((f) => (
            <div key={f.id} className="flex flex-wrap items-baseline gap-1.5">
              <span className="font-editorial text-[11.5px] leading-snug text-foreground/75">
                {f.text}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void post(
                    { decide: { id: f.id, status: "aprobado" } },
                    "No se pudo aprobar",
                  )
                }
                className="rounded-sm border border-emerald-600/40 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-emerald-700 transition-colors disabled:opacity-40 dark:text-emerald-300"
              >
                es mío
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void post(
                    { decide: { id: f.id, status: "rechazado" } },
                    "No se pudo rechazar",
                  )
                }
                className="rounded-sm border border-border/40 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-40"
              >
                no
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {!items.length && !canPropose ? (
        <p className="mt-1 font-mono text-[9.5px] leading-relaxed text-muted-foreground/50">
          Hacen falta marco y tesis antes de poder decir qué te haría estar
          equivocado.
        </p>
      ) : null}
    </div>
  );
}
