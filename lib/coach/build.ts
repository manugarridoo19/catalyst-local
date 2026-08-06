import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import {
  coreOf,
  describeAxes,
  parseAttributions,
  parseAxes,
  readingOf,
  type Attribution,
  type Axes,
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
  axes: Axes | null;
  frameLabel: string | null;
  /** Lo que el núcleo significa PARA ESTE MARCO. Es la vara contra la que
   *  se lee todo lo demás, así que se enseña. */
  core: string | null;
  /** Cuándo se declaró por última vez el marco vigente (`null` = nunca se
   *  tocó desde que existe el log). */
  frameSetAt: string | null;
  /** Qué decía el marco ANTES de ese cambio. `null` con `frameSetAt` puesto
   *  significa que la posición estaba sin clasificar: fue la clasificación
   *  inicial, no una reclasificación, y el panel las nombra distinto. */
  framePrev: Axes | null;
  framePrevLabel: string | null;
  /**
   * El marco se movió DESPUÉS del comunicado que se está leyendo con él.
   *
   * Es el caso que justifica todo el log: la vara con la que se juzga se
   * cambió sabiendo ya el resultado, así que la lectura de abajo no es una
   * predicción que se cumplió, es una casilla ajustada al hecho. No es una
   * acusación —reclasificar puede ser lo correcto, la empresa cambia— pero
   * el panel no puede callárselo.
   */
  frameChangedAfterReport: boolean;
  /** El marco se movió DESPUÉS de escribir la tesis vigente: lo que creías
   *  al operar se está leyendo con una vara que entonces no era ésa. */
  frameChangedAfterThesis: boolean;
  /** La tesis vigente: la más reciente que escribiste al operar en este
   *  valor. Ver `loadContrasts` para por qué la más reciente y no todas. */
  thesis: string | null;
  thesisAt: string | null;
  thesisHorizon: TradeHorizon | null;
  /** true si esa tesis se anotó DESPUÉS de operar. Se propaga hasta la UI:
   *  una tesis escrita sabiendo el resultado no es una predicción y el
   *  panel no puede presentarla como si lo fuera. */
  thesisAnnotatedLater: boolean;
  /**
   * Lo que crees HOY sobre la posición, declarado sobre la posición y no
   * sobre una operación. CONVIVE con `thesis` en vez de sustituirla, y el
   * panel las etiqueta distinto: la del diario es lo que pensabas al
   * operar —atada a un precio y a una fecha que ya pasaron—, ésta es una
   * creencia sobre el presente. Fundirlas presentaría como predicción algo
   * que nunca lo fue.
   *
   * Es la única vía de las posiciones ANTERIORES al diario: sin fila que
   * anotar, `annotate` no tiene dónde escribir.
   */
  belief: string | null;
  beliefAt: string | null;
  beliefHorizon: TradeHorizon | null;
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
  frame_madurez: string | null;
  frame_capital: string | null;
  frame_ciclo: string | null;
  thesis: string | null;
  thesis_at: string | null;
  thesis_horizon: string | null;
  thesis_annotated_later: boolean | null;
  attribution: string | null;
  report_date: string | null;
  frame_set_at: string | null;
  frame_prev_madurez: string | null;
  frame_prev_capital: string | null;
  frame_prev_ciclo: string | null;
  belief: string | null;
  belief_at: string | null;
  belief_horizon: string | null;
};

/**
 * ¿El marco se movió después de `fecha`?
 *
 * Comparación de cadenas `YYYY-MM-DD`, que en ese formato ordena igual que
 * las fechas. ESTRICTAMENTE posterior: un cambio el MISMO día que el
 * comunicado no se marca. La resolución del dato es el día, así que
 * "mismo día" no distingue "lo cambié antes de leerlo" de "lo cambié
 * después", y el coach no afirma lo que no puede probar — la misma
 * doctrina que baja un `mortal` sin cita a `vigilar`.
 */
export function movedAfter(
  frameSetAt: string | null,
  fecha: string | null,
): boolean {
  if (!frameSetAt || !fecha) return false;
  return frameSetAt > fecha;
}

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
      ),
      -- Sólo el ÚLTIMO cambio de marco: el panel contrasta el marco vigente
      -- con el inmediatamente anterior, no cuenta la historia entera. La
      -- cadena completa está en la tabla para quien la audite.
      ultimo_marco AS (
        SELECT DISTINCT ON (symbol)
               symbol,
               to_char(changed_at at time zone 'UTC','YYYY-MM-DD') AS frame_set_at,
               from_madurez AS frame_prev_madurez,
               from_capital AS frame_prev_capital,
               from_ciclo   AS frame_prev_ciclo
          FROM frame_changes
         WHERE user_session = ${session}
         ORDER BY symbol, changed_at DESC, id DESC
      )
      SELECT w.symbol, t.name, w.frame_madurez, w.frame_capital, w.frame_ciclo,
             ut.thesis, ut.thesis_at, ut.thesis_horizon, ut.thesis_annotated_later,
             ui.attribution, ui.report_date,
             um.frame_set_at, um.frame_prev_madurez, um.frame_prev_capital,
             um.frame_prev_ciclo,
             w.thesis AS belief, w.thesis_horizon AS belief_horizon,
             to_char(w.thesis_declared_at at time zone 'UTC','YYYY-MM-DD')
               AS belief_at
        FROM watchlist w
        LEFT JOIN tickers t ON t.symbol = w.symbol
        LEFT JOIN ultima_tesis ut ON ut.symbol = w.symbol
        LEFT JOIN ultimo_informe ui ON ui.symbol = w.symbol
        LEFT JOIN ultimo_marco um ON um.symbol = w.symbol
       WHERE w.user_session = ${session}
         AND w.shares IS NOT NULL AND w.shares > 0
       ORDER BY w.symbol
    `),
  );

  return rows.map((r) => {
    const axes = parseAxes({
      madurez: r.frame_madurez,
      capital: r.frame_capital,
      ciclo: r.frame_ciclo,
    });
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
    if (!axes) missing.push("marco");
    // Cualquiera de las dos basta para que el coach tenga TUS palabras
    // contra las que leer: una posición anterior al diario nunca tendrá la
    // del diario, y seguir pidiéndosela sería pedir algo imposible.
    if (!r.thesis && !r.belief) missing.push("tesis");
    if (!attributions.length) missing.push("comunicado");

    // El marco anterior pasa por el MISMO `parseAxes` que el vigente: una
    // fila de log con los tres ejes a null es "estaba sin clasificar", y
    // eso hace que el cambio sea la clasificación INICIAL, no una
    // reclasificación. El panel las nombra distinto porque no son lo mismo.
    const framePrev = parseAxes({
      madurez: r.frame_prev_madurez,
      capital: r.frame_prev_capital,
      ciclo: r.frame_prev_ciclo,
    });

    return {
      symbol: r.symbol,
      name: r.name,
      axes,
      frameLabel: axes ? describeAxes(axes) : null,
      core: axes ? coreOf(axes) : null,
      frameSetAt: r.frame_set_at,
      framePrev,
      framePrevLabel: framePrev ? describeAxes(framePrev) : null,
      frameChangedAfterReport: movedAfter(r.frame_set_at, r.report_date),
      frameChangedAfterThesis: movedAfter(r.frame_set_at, r.thesis_at),
      thesis: r.thesis,
      thesisAt: r.thesis_at,
      thesisHorizon: isTradeHorizon(r.thesis_horizon) ? r.thesis_horizon : null,
      thesisAnnotatedLater: r.thesis_annotated_later === true,
      belief: r.belief,
      beliefAt: r.belief_at,
      beliefHorizon: isTradeHorizon(r.belief_horizon) ? r.belief_horizon : null,
      readings: attributions.map((a) => {
        // El quote decide si un "mortal" se puede afirmar: sin la frase de
        // la empresa, la capa es inferencia y el veredicto baja a vigilar.
        const read = readingOf(axes, a.signal, a.layer, a.quote);
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
  confirma: 3,
};

export function sortContrasts(list: PositionContrast[]): PositionContrast[] {
  const worst = (c: PositionContrast) =>
    Math.min(
      ...c.readings.map((r) => SEVERITY_RANK[r.severity ?? ""] ?? 4),
      4,
    );
  return [...list].sort((a, b) => {
    const d = worst(a) - worst(b);
    if (d !== 0) return d;
    // A igualdad, primero las que SÍ se pueden leer: una posición a la que
    // le falta el marco no es una alarma, es una casilla por rellenar.
    return a.missing.length - b.missing.length;
  });
}
