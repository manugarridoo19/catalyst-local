// Dilución: ¿cuántas acciones más hay que hace un año, y por qué?
//
// LO QUE MIDE Y POR QUÉ NO ES "RECOMPRAS".
//
// Una empresa puede anunciar recompras milmillonarias y tener MÁS acciones al
// final del año: si el pago en acciones a empleados emite más de lo que la
// recompra retira, la recompra no está devolviendo capital, está tapando la
// dilución. Por eso el titular de este módulo es el CONTEO DE ACCIONES —el
// resultado— y el SBC y las recompras entran como explicación, no como
// veredicto. Es la crítica exacta al «EBITDA ajustado» que suma de vuelta el
// SBC: para quien ya es accionista, esa emisión es un coste real.
//
// FUENTE: XBRL de la SEC (`companyconcept`), no un proveedor de datos. Es
// gratis, autoritativa y sale del mismo documento que audita la empresa.
// Finnhub NO la da: `shareOutstanding` no está ni en su objeto plano ni en
// ninguna de sus 39 series (comprobado el 2026-08-11).

/** Un punto tal y como lo devuelve `companyconcept`. */
export type XbrlPoint = {
  /** Inicio del periodo. Ausente en conceptos de saldo (no de flujo). */
  start?: string;
  end: string;
  val: number;
  /** Fecha de PRESENTACIÓN. Es el desempate entre reexpresiones. */
  filed: string;
  form: string;
  /** Marco normalizado de la SEC ("CY2026"). No siempre viene. */
  frame?: string;
  /** Ejercicio del INFORME que lo reportó, NO del periodo. Ver abajo. */
  fy?: number | null;
  fp?: string | null;
};

/** Duración en días de un punto, o `null` si no es un periodo. */
function durationDays(p: XbrlPoint): number | null {
  if (!p.start) return null;
  const a = Date.parse(p.start);
  const b = Date.parse(p.end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Bandas de duración. Un trimestre "de 91 días" puede tener 84 o 98 según
 *  el calendario fiscal de cada empresa, así que son bandas y no igualdades. */
const ANNUAL = { min: 330, max: 400 };
const QUARTERLY = { min: 75, max: 115 };

/**
 * Un punto por PERIODO, quedándose con la presentación más reciente.
 *
 * ─── EL BUG QUE ESTO EVITA ────────────────────────────────────────────────
 *
 * `fy` y `fp` NO identifican el periodo del dato: identifican el informe que
 * lo reportó. Cada 10-K reexpresa los ejercicios anteriores como
 * comparativos, así que el mismo periodo aparece varias veces con `fy`
 * distinto. Medido en MSFT: el año 2023-07-01→2024-06-30 sale con `fy` 2024,
 * 2025 y 2026, más una copia en un 8-K.
 *
 * Emparejar el interanual con `fy = actual - 1` parece lo natural y da el
 * dato equivocado. Peor: como las reexpresiones suelen coincidir en valor,
 * ACERTARÍA casi siempre y fallaría justo el día que hay una reexpresión de
 * verdad — que es exactamente el día en que querrías fiarte del número.
 *
 * La clave es el periodo (`start`→`end`) y el desempate es `filed`: la
 * presentación más reciente es la versión vigente de ese periodo.
 */
export function canonicalPoints(points: XbrlPoint[]): XbrlPoint[] {
  const porPeriodo = new Map<string, XbrlPoint>();
  for (const p of points) {
    if (!p.start || !p.end || !Number.isFinite(p.val)) continue;
    const clave = `${p.start}|${p.end}`;
    const previo = porPeriodo.get(clave);
    if (!previo || p.filed > previo.filed) porPeriodo.set(clave, p);
  }
  return [...porPeriodo.values()].sort((a, b) => (a.end < b.end ? -1 : 1));
}

export type PeriodPick = {
  latest: XbrlPoint;
  yearAgo: XbrlPoint;
  /** "annual" | "quarterly" — qué cadencia se pudo emparejar. */
  cadence: "annual" | "quarterly";
};

/**
 * El punto más reciente y su homólogo de hace un año, de la MISMA cadencia.
 *
 * Prefiere trimestral (más fresco) y cae a anual, que es lo único que
 * publican los emisores extranjeros: NU presenta 20-F una vez al año, así
 * que su dato más nuevo puede tener 18 meses. Eso no es un fallo, es su
 * régimen de información — y por eso la cadencia se devuelve y se enseña.
 *
 * Comparar un trimestre contra un año daría una "dilución" del 300% sin que
 * nada fallara, así que las dos puntas salen SIEMPRE de la misma banda.
 */
export function pickYoY(points: XbrlPoint[]): PeriodPick | null {
  const canon = canonicalPoints(points);
  for (const [cadence, banda] of [
    ["quarterly", QUARTERLY],
    ["annual", ANNUAL],
  ] as const) {
    const enBanda = canon.filter((p) => {
      const d = durationDays(p);
      return d !== null && d >= banda.min && d <= banda.max;
    });
    if (enBanda.length < 2) continue;
    const latest = enBanda[enBanda.length - 1];
    const objetivo = Date.parse(latest.end) - 365 * 86_400_000;
    // El homólogo tiene que caer dentro de ±45 días del aniversario. Sin esa
    // ventana, una empresa con un solo año de historia emparejaría contra el
    // trimestre anterior y publicaría una dilución trimestral como anual.
    let mejor: XbrlPoint | null = null;
    let mejorDist = Infinity;
    for (const p of enBanda) {
      if (p.end >= latest.end) continue;
      const dist = Math.abs(Date.parse(p.end) - objetivo);
      if (dist < mejorDist) {
        mejorDist = dist;
        mejor = p;
      }
    }
    if (mejor && mejorDist <= 45 * 86_400_000) {
      return { latest, yearAgo: mejor, cadence };
    }
  }
  return null;
}

export type Dilution = {
  /** Acciones diluidas medias del último periodo publicado. */
  dilutedShares: number | null;
  /** Las del mismo periodo del año anterior. */
  dilutedSharesYearAgo: number | null;
  /**
   * Variación interanual del CONTEO en %. Positivo = dilución.
   *
   * Es el titular del bloque a propósito: mide el RESULTADO, no la
   * intención. Una empresa puede recomprar mucho y aun así diluir.
   */
  dilutionPct: number | null;
  /** Pago en acciones del último periodo, en dólares. */
  sbc: number | null;
  /** Recompras del último periodo, en dólares. `null` = no publica el
   *  concepto, que en una empresa en pérdidas normalmente significa que no
   *  recompra — no que falte el dato. */
  buybacks: number | null;
  /** Fin del periodo del dato de acciones ("2026-06-30"). */
  periodEnd: string | null;
  /** Formulario del que sale ("10-K", "10-Q", "20-F"). */
  periodForm: string | null;
  /** "annual" | "quarterly": con qué cadencia se pudo comparar. */
  cadence: "annual" | "quarterly" | null;
  /** Taxonomía usada: `us-gaap` o `ifrs-full` (emisores extranjeros). */
  taxonomy: string | null;
};

export const EMPTY_DILUTION: Dilution = {
  dilutedShares: null,
  dilutedSharesYearAgo: null,
  dilutionPct: null,
  sbc: null,
  buybacks: null,
  periodEnd: null,
  periodForm: null,
  cadence: null,
  taxonomy: null,
};

/** Valor del periodo más reciente de una serie, sin exigir homólogo. */
export function latestValue(points: XbrlPoint[]): number | null {
  const canon = canonicalPoints(points);
  return canon.length ? canon[canon.length - 1].val : null;
}

/**
 * Magnitud de una SALIDA (gasto o pago), sin signo.
 *
 * El convenio de signo no es el mismo entre taxonomías ni entre presentantes:
 * medido en NU, el `ExpenseFromSharebasedPaymentTransactionsWithEmployees` de
 * IFRS llega como **−372.669.000** porque se declara como deducción, mientras
 * el `ShareBasedCompensation` de us-gaap llega positivo. Pintado tal cual, el
 * panel enseñaba "SBC −372M", que se lee como si la empresa hubiera INGRESADO
 * dinero por pagar en acciones.
 *
 * Se normaliza a magnitud porque lo que se muestra es "cuánto", no un asiento
 * contable. Un gasto negativo de verdad (una reversión) es rarísimo y su
 * signo no cabe en esta lectura de todos modos.
 */
function outflow(v: number | null): number | null {
  return v === null ? null : Math.abs(v);
}

export function deriveDilution(input: {
  shares: XbrlPoint[];
  sbc: XbrlPoint[];
  buybacks: XbrlPoint[];
  taxonomy: string;
}): Dilution {
  const pick = pickYoY(input.shares);
  if (!pick) {
    // Sin las dos puntas no hay dilución que publicar. Se devuelven las
    // piezas sueltas si las hay: un SBC sin conteo sigue siendo un dato.
    return {
      ...EMPTY_DILUTION,
      dilutedShares: latestValue(input.shares),
      sbc: outflow(latestValue(input.sbc)),
      buybacks: outflow(latestValue(input.buybacks)),
      taxonomy: input.taxonomy,
    };
  }
  const antes = pick.yearAgo.val;
  const ahora = pick.latest.val;
  return {
    dilutedShares: ahora,
    dilutedSharesYearAgo: antes,
    // Denominador cero no es "dilución infinita", es dato inservible.
    dilutionPct: antes > 0 ? ((ahora - antes) / antes) * 100 : null,
    sbc: outflow(latestValue(input.sbc)),
    buybacks: outflow(latestValue(input.buybacks)),
    periodEnd: pick.latest.end,
    periodForm: pick.latest.form,
    cadence: pick.cadence,
    taxonomy: input.taxonomy,
  };
}

/**
 * Umbral declarado por las propias empresas al fijarse un tope de dilución
 * anual. NO es un veredicto del sistema: es la vara que la industria usa
 * para hablar de esto, y sirve para que el panel diga "por encima/por debajo
 * de lo que las empresas se ponen como objetivo" en vez de un color.
 *
 * Vive aquí y no incrustado en la vista por la misma razón que
 * `DECISION_THRESHOLDS`: es tolerancia declarada, no un hecho, y se discute
 * en un solo sitio.
 */
export const DILUTION_TARGET_PCT = 2.5;
