import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import {
  isFrame,
  parseAttributions,
  readingOf,
  FRAME_SPEC,
  type Attribution,
  type Frame,
  type Severity,
} from "@/lib/coach/frames";
import { isTradeHorizon, type TradeHorizon } from "@/lib/coach/horizon";

// Arma el CONTRASTE que ve el usuario: lo que él escribió frente a lo que
// se ha movido, con la atribución de la propia empresa delante.
//
// SIN NINGUNA LLAMADA A LLM, y no por ahorro. El contraste está compuesto
// enteramente de cosas que ya son ciertas: tu tesis es tu texto, la
// atribución es una cita del comunicado, y la lectura sale de una tabla en
// código. No hay nada que redactar y por tanto nada que el modelo pueda
// adornar. La prosa (y los falsadores) se añaden encima, y si la cuota se
// agota el panel sigue diciendo lo mismo.
//
// LO QUE ESTE MÓDULO NO HACE: concluir. No existe un campo "tesis rota".
// Con lo que describía el usuario —márgenes que se estrechan por comprar
// futuro y no por deterioro— cualquier conclusión automática acierta a
// medias, y un coach que acierta a medias sobre dinero se deja de leer.
// Afirmar sólo se puede cuando se cumple un falsador que él aprobó.

export type PositionContrast = {
  symbol: string;
  name: string | null;
  frame: Frame | null;
  frameLabel: string | null;
  /** Lo que el núcleo significa PARA ESTE MARCO. Es la vara contra la que
   *  se lee todo lo demás, así que se enseña. */
  core: string | null;
  /** La tesis vigente: la más reciente que escribiste al operar en este
   *  valor. Ver `loadContrasts` para por qué la más reciente y no todas. */
  thesis: string | null;
  thesisAt: string | null;
  thesisHorizon: TradeHorizon | null;
  /** true si esa tesis se anotó DESPUÉS de operar. Se propaga hasta la UI:
   *  una tesis escrita sabiendo el resultado no es una predicción y el
   *  panel no puede presentarla como si lo fuera. */
  thesisAnnotatedLater: boolean;
  /** Movimientos del último comunicado, ya leídos contra el marco. */
  readings: Array<{
    attribution: Attribution;
    severity: Severity | null;
    note: string;
  }>;
  reportDate: string | null;
  /** Qué le falta a esta posición para que el coach pueda hablar. Se
   *  devuelve explícito en vez de dejar huecos mudos: un panel vacío se lee
   *  como "todo en orden", que es lo contrario de lo que pasa. */
  missing: Array<"marco" | "tesis" | "comunicado">;
};

type Row = {
  symbol: string;
  name: string | null;
  frame: string | null;
  thesis: string | null;
  thesis_at: string | null;
  thesis_horizon: string | null;
  thesis_annotated_later: boolean | null;
  attribution: string | null;
  report_date: string | null;
};

/**
 * Una consulta para toda la cartera.
 *
 * La tesis vigente es la MÁS RECIENTE de las operaciones de ese símbolo, no
 * la primera ni todas juntas: si reforzaste META tres veces, lo que crees
 * hoy es lo que escribiste la última vez. El `DISTINCT ON` con el orden
 * descendente es exactamente eso y evita traerse el diario entero para
 * quedarse con una fila por símbolo.
 *
 * `LEFT JOIN` en las dos: una posición sin operaciones registradas (las que
 * ya tenías antes del diario) y una sin comunicado reciente son estados
 * NORMALES, y tienen que llegar al panel para que diga qué les falta.
 */
export async function loadContrasts(
  session: string,
): Promise<PositionContrast[]> {
  const rows = unwrapRows<Row>(
    await db.execute(sql`
      WITH ultima_tesis AS (
        SELECT DISTINCT ON (symbol)
               symbol, thesis, horizon AS thesis_horizon,
               annotated_later AS thesis_annotated_later,
               to_char(created_at at time zone 'UTC','YYYY-MM-DD') AS thesis_at
          FROM position_trades
         WHERE user_session = ${session}
           AND thesis IS NOT NULL
         ORDER BY symbol, created_at DESC, id DESC
      ),
      ultimo_informe AS (
        SELECT DISTINCT ON (symbol)
               symbol, attribution, COALESCE(report_date, filing_date) AS report_date
          FROM earnings_reports
         ORDER BY symbol, filing_date DESC
      )
      SELECT w.symbol, t.name, w.frame,
             ut.thesis, ut.thesis_at, ut.thesis_horizon, ut.thesis_annotated_later,
             ui.attribution, ui.report_date
        FROM watchlist w
        LEFT JOIN tickers t ON t.symbol = w.symbol
        LEFT JOIN ultima_tesis ut ON ut.symbol = w.symbol
        LEFT JOIN ultimo_informe ui ON ui.symbol = w.symbol
       WHERE w.user_session = ${session}
         AND w.shares IS NOT NULL AND w.shares > 0
       ORDER BY w.symbol
    `),
  );

  return rows.map((r) => {
    const frame = isFrame(r.frame) ? r.frame : null;
    let attributions: Attribution[] = [];
    if (r.attribution) {
      try {
        attributions = parseAttributions(JSON.parse(r.attribution));
      } catch {
        // Un JSON corrupto en una fila no puede tumbar el panel entero: esa
        // posición se queda sin lecturas y `missing` lo dirá.
        attributions = [];
      }
    }

    const missing: PositionContrast["missing"] = [];
    if (!frame) missing.push("marco");
    if (!r.thesis) missing.push("tesis");
    if (!attributions.length) missing.push("comunicado");

    return {
      symbol: r.symbol,
      name: r.name,
      frame,
      frameLabel: frame ? FRAME_SPEC[frame].label : null,
      core: frame ? FRAME_SPEC[frame].core : null,
      thesis: r.thesis,
      thesisAt: r.thesis_at,
      thesisHorizon: isTradeHorizon(r.thesis_horizon) ? r.thesis_horizon : null,
      thesisAnnotatedLater: r.thesis_annotated_later === true,
      readings: attributions.map((a) => {
        const read = readingOf(frame, a.signal, a.layer);
        return { attribution: a, severity: read.severity, note: read.note };
      }),
      reportDate: r.report_date,
      missing,
    };
  });
}

/** Orden de lectura del panel: primero lo que golpea la tesis, después lo
 *  que hay que vigilar, y al final lo esperado — que se enseña igualmente
 *  porque «esto que parece malo es lo que compraste» es de las cosas más
 *  útiles que el panel puede decirte, pero no es lo primero que se mira. */
const SEVERITY_RANK: Record<string, number> = {
  mortal: 0,
  vigilar: 1,
  esperado: 2,
};

export function sortContrasts(list: PositionContrast[]): PositionContrast[] {
  const worst = (c: PositionContrast) =>
    Math.min(
      ...c.readings.map((r) => SEVERITY_RANK[r.severity ?? ""] ?? 3),
      3,
    );
  return [...list].sort((a, b) => {
    const d = worst(a) - worst(b);
    if (d !== 0) return d;
    // A igualdad, primero las que SÍ se pueden leer: una posición a la que
    // le falta el marco no es una alarma, es una casilla por rellenar.
    return a.missing.length - b.missing.length;
  });
}
