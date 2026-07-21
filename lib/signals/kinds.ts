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
  ai_pick: {
    label: "AI Pick",
    description: "Selección de AI Picks (momentum en construcción).",
    cooldownDays: 3,
  },
  cluster_buy: {
    label: "Cluster buy",
    description: "≥2 insiders distintos comprando a mercado abierto en 7d.",
    cooldownDays: 14,
  },
  insider_net_buy: {
    label: "Insider net buy",
    description: "Compra neta insider >$1M en 7d (open market).",
    cooldownDays: 14,
  },
  stake_13d: {
    label: "13D stake",
    description: "Nueva participación activista >5% (SC 13D).",
    cooldownDays: 0,
  },
  analyst_upgrade: {
    label: "Analyst upgrade",
    description: "Noticia ANALYST con impact ≥4 y sentiment ≥ +2.",
    cooldownDays: 3,
  },
  author_call: {
    label: "Author call",
    description: "Valor mencionado en el brief diario de Author Watch.",
    cooldownDays: 3,
  },
};

export function kindLabel(kind: string): string {
  return KIND_SPECS[kind as SignalKind]?.label ?? kind;
}
