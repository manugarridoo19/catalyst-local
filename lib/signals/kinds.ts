// Catálogo de kinds del Signal Lab. Fuente ÚNICA: detección, cooldowns,
// etiquetas de /lab y priors leen de aquí. La fase 3 añadirá
// `short_squeeze_setup` y `fund_new_position` — basta con una entrada nueva.

export const SIGNAL_KINDS = [
  "ai_pick",
  "cluster_buy",
  "insider_net_buy",
  "stake_13d",
  "analyst_upgrade",
  "author_call",
  "short_squeeze_setup",
  "fund_new_position",
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

// Horizontes medidos, en DÍAS HÁBILES (sesiones reales) tras la baseline.
export const HORIZONS = [1, 7, 30] as const;
export type Horizon = (typeof HORIZONS)[number];

// N mínimo para que una estadística deje de mostrarse como "n pequeño".
export const MIN_SAMPLE = 20;

export type KindSpec = {
  label: string;
  description: string;
  // Días durante los que NO se vuelve a registrar una señal del mismo kind
  // para el mismo símbolo. Es la SEGUNDA capa de idempotencia:
  //   - UNIQUE(kind, symbol, ref_id) impide que el tick de 10min duplique
  //     la MISMA señal (mismo refId).
  //   - el cooldown impide que la misma HISTORIA se cuente varias veces con
  //     refIds distintos. AI Picks se regenera cada 4h: sin cooldown, un
  //     valor elegido durante dos días entraría ~12 veces en la muestra y
  //     el track record contaría 12 observaciones casi idénticas como si
  //     fueran independientes (N inflado, medias falsamente precisas).
  // 0 = cada refId es un evento discreto de verdad (un filing 13D nuevo).
  cooldownDays: number;
};

export const KIND_SPECS: Record<SignalKind, KindSpec> = {
  // `description` se PINTA en /lab, así que va en inglés como el resto de la
  // interfaz; los comentarios de código siguen en castellano.
  ai_pick: {
    label: "AI Pick",
    description: "Selected by AI Picks as momentum building.",
    cooldownDays: 3,
  },
  cluster_buy: {
    label: "Cluster buy",
    description: "2+ distinct insiders buying on the open market in 7d.",
    cooldownDays: 14,
  },
  insider_net_buy: {
    label: "Insider net buy",
    description: "Net insider buying above $1M in 7d (open market).",
    cooldownDays: 14,
  },
  stake_13d: {
    label: "13D stake",
    description: "New activist 5%+ position (SC 13D).",
    cooldownDays: 0,
  },
  analyst_upgrade: {
    label: "Analyst upgrade",
    description: "Analyst news scored impact 4+ and sentiment +2 or better.",
    cooldownDays: 3,
  },
  author_call: {
    label: "Author call",
    description: "Name discussed in the daily Author Watch brief.",
    cooldownDays: 3,
  },
  // Cooldown 14d = una quincena de FINRA: el dato sólo cambia dos veces al
  // mes, así que sin él la misma foto de short interest se re-registraría
  // cada vez que entra una noticia alcista nueva.
  short_squeeze_setup: {
    label: "Short squeeze setup",
    description:
      "Days-to-cover above 5 with 2+ bullish high-impact stories in 7d.",
    cooldownDays: 14,
  },
  // Sin cooldown: el refId ya es fondo+trimestre, y que DOS fondos distintos
  // abran la misma posición el mismo trimestre son dos observaciones de
  // verdad, no una repetida — justo la señal de convicción que interesa.
  fund_new_position: {
    label: "Fund new position",
    description: "A curated 13F filer opened a position this quarter.",
    cooldownDays: 0,
  },
};

export function kindLabel(kind: string): string {
  return KIND_SPECS[kind as SignalKind]?.label ?? kind;
}
