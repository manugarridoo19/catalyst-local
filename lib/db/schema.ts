import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  pgTable,
  text,
  integer,
  smallint,
  bigint,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  serial,
  pgEnum,
} from "drizzle-orm/pg-core";

// Cómo se asoció un ticker a una noticia (para auditar calidad).
export const extractionMethodEnum = pgEnum("extraction_method", [
  "api",
  "regex",
  "dict",
]);

// Categoría editorial de la noticia. Se asigna heurísticamente al insertar
// (basado en source + keywords) y opcionalmente la sobreescribe el LLM
// durante el scoring. Pensada para filtrar el feed por tipo de catalyst.
export const newsCategoryEnum = pgEnum("news_category", [
  "EARNINGS",
  "MA",
  "ANALYST",
  "GUIDANCE",
  "INSIDER",
  "REGULATORY",
  "PRODUCT",
  "LEGAL",
  "MACRO",
  "OTHER",
]);

// Universo dinámico: cada vez que un proveedor menciona un ticker nuevo se
// inserta aquí. Los detalles (name/sector) se enriquecen perezosamente.
export const tickers = pgTable(
  "tickers",
  {
    symbol: text("symbol").primaryKey(),
    name: text("name"),
    sector: text("sector"),
    industry: text("industry"),
    marketCap: bigint("market_cap", { mode: "number" }),
    logoUrl: text("logo_url"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    source: text("source"), // qué proveedor lo trajo primero (finnhub, marketaux, rss)
  },
  (t) => [index("tickers_first_seen_idx").on(t.firstSeenAt)],
);

// Noticias normalizadas y deduplicadas. `hash` permite dedupe rápido cuando
// la misma URL aparece con tracking params distintos.
export const news = pgTable(
  "news",
  {
    id: serial("id").primaryKey(),
    url: text("url").notNull(),
    hash: text("hash").notNull(),
    headline: text("headline").notNull(),
    source: text("source").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    body: text("body"),
    imageUrl: text("image_url"),
    category: newsCategoryEnum("category"),
    // Nº de veces que un batch de scoring devolvió respuesta PERO omitió/
    // malformó este item. Con >= 5 el picker lo abandona (badge "—" para
    // siempre) en vez de reintentar eternamente. Solo se incrementa cuando
    // el batch produjo al menos un score (fallo de provider ≠ item malo).
    scoringAttempts: smallint("scoring_attempts").notNull().default(0),
    // Claim del picker de scoring: GH cron, scorer local y drains manuales
    // corren contra la misma BD; sin claim, dos pickers simultáneos eligen
    // los mismos items y duplican gasto de cuota LLM. TTL 10min en el
    // picker — un claim de un proceso muerto expira solo.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Marca de intento de parseo estructurado insider (sec-edgar Form 4 /
    // 13D/G → insider_trades / fund_stakes). Se pone SIEMPRE al intentar,
    // haya salido bien o no — sin ella un filing sin transacciones (p.ej.
    // amendment vacío) se re-fetchearía de SEC en cada tick para siempre.
    insiderParsedAt: timestamp("insider_parsed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("news_url_unique").on(t.url),
    uniqueIndex("news_hash_unique").on(t.hash),
    index("news_published_idx").on(t.publishedAt),
    // Filtro del feed por categoría (tabs Earnings/M&A/Analyst/Guidance/...).
    // Sin este índice la query era seq-scan sobre ~20k filas + index post-filter.
    index("news_category_idx").on(t.category),
  ],
);

// N:M entre news y tickers — una noticia puede tocar varios símbolos.
export const newsTickers = pgTable(
  "news_tickers",
  {
    newsId: integer("news_id")
      .notNull()
      .references(() => news.id, { onDelete: "cascade" }),
    ticker: text("ticker")
      .notNull()
      .references(() => tickers.symbol, { onDelete: "cascade" }),
    extractionMethod: extractionMethodEnum("extraction_method").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.newsId, t.ticker] }),
    index("news_tickers_ticker_idx").on(t.ticker),
  ],
);

// Sentiment + impacto puntuado por LLM. 1-5 impacto (cuán importante),
// -5..+5 sentiment (negativo→positivo).
export const newsScores = pgTable("news_scores", {
  newsId: integer("news_id")
    .primaryKey()
    .references(() => news.id, { onDelete: "cascade" }),
  impact: smallint("impact").notNull(),
  sentiment: smallint("sentiment").notNull(),
  rationale: text("rationale"),
  // Resumen IA en lenguaje claro (1 frase). Solo se genera para noticias de
  // alto impacto (impact>=4) dentro del mismo batch de scoring — coste LLM
  // marginal ≈0. NULL para el resto. Se muestra en la card expandida.
  summary: text("summary"),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  scoredAt: timestamp("scored_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  // Filtro "High impact" del feed (impact >= 4). Sin índice era seq-scan.
  index("news_scores_impact_idx").on(t.impact),
]);

// Watchlist single-user en v1 — userSession es una cookie.
//
// Desde 2026-07-25 es TAMBIÉN la cartera: `shares`/`avgCost` convierten una
// fila de seguimiento en una posición real. Se amplió esta tabla en vez de
// crear `positions` aparte porque ~8 sitios ya leen de aquí (feed, brief,
// earnings, universo de tickers) y una tabla paralela habría obligado a
// decidir en cada uno cuál de las dos listas manda.
//
// Ambas columnas son NULLABLE y esa es la distinción de producto:
//   shares NULL → sigo este nombre, no lo tengo.
//   shares > 0  → posición; entra en pesos, P&L y revisión de cartera.
// Un 0 explícito NO es lo mismo que NULL: es una posición cerrada que se
// quiere seguir vigilando (y así el histórico de `addedAt` no se pierde).
//
// doublePrecision y no text (el criterio de quotes_cache/earnings_events):
// aquí se hace ARITMÉTICA — peso, valor de mercado, P&L. Los text de esas
// otras tablas sólo se pintan. Fraccionario porque los brokers europeos
// venden fracciones de acción.
export const watchlist = pgTable(
  "watchlist",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol")
      .notNull()
      .references(() => tickers.symbol, { onDelete: "cascade" }),
    userSession: text("user_session").notNull(),
    /** Nº de acciones. NULL = solo seguimiento, 0 = posición cerrada. */
    shares: doublePrecision("shares"),
    /** Coste medio POR ACCIÓN, en la moneda de cotización del valor.
     *  Sin FX: una cartera que mezcle USD y EUR sumaría peras con manzanas
     *  en el total — el universo de Catalyst es US, y si algún día entra
     *  algo europeo hay que añadir divisa antes de fiarse del agregado. */
    avgCost: doublePrecision("avg_cost"),
    /**
     * Qué CLASE de empresa crees que es: 'power_play' | 'compounder' |
     * 'turnaround' | 'ciclica'. Ver `lib/coach/frames.ts`.
     *
     * Va en la POSICIÓN y no en la operación porque el marco pertenece a la
     * empresa, no a cada compra suelta: si reforzaras META tres veces, las
     * tres serían la misma apuesta sobre la misma clase de negocio.
     *
     * Es lo que decide si una señal es ruido o es mortal — el mismo capex
     * disparado es la tesis ejecutándose en una power play y una tesis rota
     * en un compounder. NULLABLE porque no se puede inventar: sin marco, el
     * coach dice que no puede leerlo, que es preferible a leerlo al revés.
     */
    frame: text("frame"),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("watchlist_session_symbol_unique").on(
      t.userSession,
      t.symbol,
    ),
  ],
);

/**
 * Registro de operaciones sobre una posición. APPEND-ONLY.
 *
 * NO es la fuente de verdad de la posición y no debe llegar a serlo:
 * `watchlist.shares` / `avg_cost` siguen siendo la forma canónica porque
 * ~8 consumidores leen de ahí (rail, tabla, /ask, revisión, prewarm…), y
 * derivar el estado sumando el log obligaría a recorrerlo entero en cada
 * lectura. Esto es el DIARIO: qué pasó, cuándo, y cómo quedó la posición
 * después. Sirve para auditar, no para calcular.
 *
 * Se guarda el estado RESULTANTE (`shares_after` / `avg_cost_after`) y no
 * sólo la operación: el coste medio de una compra depende de cuál era el
 * anterior, así que sin la foto de después una fila suelta no se puede
 * verificar sin reproducir todo el historial — y el historial empieza el
 * día que se creó esta tabla, con posiciones que ya existían.
 *
 * `realized_pnl` sólo lo llevan las ventas, y sólo cuando el coste medio
 * era conocido: es `acciones × (precio_venta − coste_medio)` calculado EN
 * EL MOMENTO de vender, que es la única forma de que siga siendo cierto
 * después. Recalcularlo más tarde contra el coste medio de hoy daría otro
 * número, porque una compra posterior lo habrá movido.
 */
export const positionTrades = pgTable(
  "position_trades",
  {
    id: serial("id").primaryKey(),
    userSession: text("user_session").notNull(),
    symbol: text("symbol").notNull(),
    /** buy = refuerzo · sell = recorte · adjust = corrección a mano.
     *  `adjust` está para que el diario no MIENTA por omisión: sin él, las
     *  acciones saltarían entre dos filas sin explicación y el lector
     *  supondría que falta una operación. */
    side: text("side").notNull(),
    /** Acciones de ESTA operación. En `adjust` es null: una corrección no
     *  es una cantidad comprada ni vendida, es un estado nuevo. */
    shares: doublePrecision("shares"),
    /** Precio de ejecución. Null en `adjust`. */
    price: doublePrecision("price"),
    realizedPnl: doublePrecision("realized_pnl"),
    sharesAfter: doublePrecision("shares_after"),
    avgCostAfter: doublePrecision("avg_cost_after"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * A qué plazo va esta operación: 'corto' | 'medio' | 'largo'.
     *
     * NO es un adorno para el prompt: lo consume el CÓDIGO y decide si se
     * emite veredicto de precio. Comprar por fundamentales a años y recibir
     * un "error" porque la acción cayó un 4% en tres semanas no es un
     * veredicto duro, es un veredicto sobre otra pregunta — y un coach que
     * hace eso se gana que dejes de leerlo, con razón.
     *
     * NULLABLE porque las operaciones anteriores a este campo existen y no
     * se les puede inventar una intención. `null` = sin clasificar: entra en
     * el diario, no en el análisis. Ver `annotated_later`.
     */
    horizon: text("horizon"),
    /** Por qué hiciste esta operación, en tus palabras. Opcional a
     *  propósito: obligarlo sube la calidad del dato y hunde la tasa de
     *  registro, y una operación anotada a medias vale más que una que no
     *  se registró. Lo que el dato NO tiene que contener es el contexto de
     *  mercado (qué hacía el precio, qué noticias había): eso lo sabe
     *  Catalyst y se adjunta solo. Aquí va sólo lo que nadie más sabe. */
    thesis: text("thesis"),
    /**
     * true = el horizonte y la tesis se anotaron DESPUÉS de operar.
     *
     * Existe por una única razón, y es la que sostiene todo el panel: una
     * tesis escrita sabiendo ya cómo fue **no es una predicción**. Sin esta
     * marca, el sesgo retrospectivo entra en los datos disfrazado de
     * criterio y el coach acabaría felicitándote por aciertos que redactaste
     * después de verlos. Es un booleano declarado y no una comparación de
     * fechas a ojo: quien escribe SABE si está anotando en el momento o a
     * posteriori, y un umbral de minutos sería adivinar lo que ya se sabe.
     */
    annotatedLater: boolean("annotated_later").notNull().default(false),
    // Control del job que mide la operación contra los precios posteriores,
    // idéntico al de `signal_events`: sin esto, un símbolo que Yahoo no
    // sirve se reintentaría en cada pasada para siempre.
    outcomeAttempts: smallint("outcome_attempts").notNull().default(0),
    lastOutcomeAt: timestamp("last_outcome_at", { withTimezone: true }),
  },
  (t) => [
    // El diario se lee SIEMPRE por (sesión, símbolo) y en orden inverso.
    index("position_trades_session_symbol_idx").on(
      t.userSession,
      t.symbol,
      t.createdAt,
    ),
  ],
);

/**
 * Los FALSADORES de una tesis: qué tendría que pasar para que estuvieras
 * equivocado.
 *
 * Es la única puerta por la que el coach puede llegar a AFIRMAR algo. Por
 * defecto contrasta y no concluye, porque el mismo hecho significa lo
 * contrario según el marco (márgenes cayendo por comprar futuro vs. por
 * deterioro) y cualquier conclusión automática acierta a medias. Cuando se
 * cumple un falsador que el usuario aprobó, el coach no está opinando: le
 * está citando su propio criterio, escrito antes de saber el resultado.
 *
 * ─── POR QUÉ SE PROPONEN Y NO SE PIDEN ─────────────────────────────────
 *
 * Pedirlos en frío empobrece la tesis: una convicción real es un cómputo de
 * muchas cosas y reducirla a tres métricas la traiciona. Así que el LLM los
 * PROPONE a partir de la tesis, el marco y lo que la empresa reporta de
 * verdad, y el usuario aprueba, edita o tira. La pregunta que contesta al
 * aprobar es la del pre-mortem —«¿qué tendría que pasar para que estuviera
 * equivocado?»—, que es la más valiosa que existe y la que nadie se hace
 * sola.
 *
 * `status` empieza en 'pendiente' SIEMPRE. Un falsador propuesto por el
 * modelo y no aprobado no puede disparar nada: sería el coach citándose a
 * sí mismo y presentándolo como criterio del usuario.
 */
export const thesisFalsifiers = pgTable(
  "thesis_falsifiers",
  {
    id: serial("id").primaryKey(),
    userSession: text("user_session").notNull(),
    symbol: text("symbol").notNull(),
    /** La condición, en lenguaje llano. "El crecimiento de ingresos del
     *  negocio principal baja del 10% dos trimestres seguidos". */
    text: text("text").notNull(),
    /** 'propuesto' = lo redactó el modelo · 'escrito' = lo escribió el
     *  usuario. Se guarda porque un falsador propuesto y aprobado sin leer
     *  no es lo mismo que uno pensado, y si algún día el panel se equivoca
     *  hay que poder saber de dónde salió. */
    source: text("source").notNull(),
    /** 'pendiente' | 'aprobado' | 'rechazado'. Sólo los aprobados evalúan. */
    status: text("status").notNull().default("pendiente"),
    /** Cuándo se cumplió, si se cumplió. NULL = no se ha cumplido o no se
     *  ha podido comprobar todavía — que no es lo mismo que "está bien". */
    trippedAt: timestamp("tripped_at", { withTimezone: true }),
    /** La cita del comunicado que lo cumple. Sin evidencia citable NO se
     *  marca como cumplido: un veredicto duro sin frase que lo respalde es
     *  exactamente lo que este diseño existe para evitar. */
    trippedEvidence: text("tripped_evidence"),
    /** Accession del último comunicado contra el que se evaluó. Hace la
     *  comprobación idempotente: sin esto, cada pasada del cron volvería a
     *  pagar una llamada LLM por el MISMO filing trimestre tras trimestre. */
    checkedAccession: text("checked_accession"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("thesis_falsifiers_session_symbol_idx").on(t.userSession, t.symbol)],
);

/**
 * Cómo le fue al mercado DESPUÉS de cada operación tuya.
 *
 * Es el gemelo de `signal_outcomes`: mismas columnas, misma semántica de
 * retorno (close-to-close sobre cierres AJUSTADOS, horizontes en días
 * hábiles contados como posiciones en la serie real de sesiones, benchmark
 * SPY entre las dos mismas fechas) y la misma medición prospectiva que
 * nunca se revisa. Si `/lab` mide las señales de Catalyst, esto mide las
 * tuyas — y compararlas sólo tiene sentido si la aritmética es la misma,
 * así que el job REUTILIZA `findBaselineDate` y `horizonReturn` en vez de
 * reimplementarlas.
 *
 * Tabla aparte y no un `kind` más de `signal_events`: los priors empíricos
 * del Lab alimentan `PICKS_SYSTEM_PROMPT`, y meter ahí las operaciones del
 * usuario contaminaría el track record de las señales del sistema con
 * decisiones humanas que no son señales de nadie.
 *
 * `return_pct` es SIEMPRE el del mercado, sin signo aplicado — neutro,
 * como el dato que es. Si esa subida fue buena o mala para ti depende de
 * si compraste o vendiste, y esa lectura vive en `lib/coach/measure.ts`,
 * en código y no en la BD: una convención de signo guardada en disco es
 * imposible de revisar después sin remedir todo.
 */
export const tradeOutcomes = pgTable(
  "trade_outcomes",
  {
    tradeId: integer("trade_id")
      .notNull()
      .references(() => positionTrades.id, { onDelete: "cascade" }),
    horizon: smallint("horizon").notNull(), // días hábiles: 1 | 7 | 30
    baselineDate: text("baseline_date").notNull(), // yyyy-mm-dd (ET)
    targetDate: text("target_date").notNull(), // yyyy-mm-dd (ET)
    baselineClose: doublePrecision("baseline_close").notNull(),
    targetClose: doublePrecision("target_close").notNull(),
    returnPct: doublePrecision("return_pct").notNull(),
    benchmarkReturnPct: doublePrecision("benchmark_return_pct"),
    filledAt: timestamp("filled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tradeId, t.horizon] }),
    index("trade_outcomes_filled_idx").on(t.filledAt),
  ],
);

// Snapshot del último precio por ticker (poll cada N min para SSR rápido).
export const quotesCache = pgTable("quotes_cache", {
  symbol: text("symbol")
    .primaryKey()
    .references(() => tickers.symbol, { onDelete: "cascade" }),
  lastPrice: text("last_price"), // text para evitar pérdida de precisión
  changePct: text("change_pct"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// "Apple Inc." → AAPL — se rellena automáticamente cuando una noticia trae
// el ticker anotado por la API y también el nombre completo en el headline.
export const tickerAliases = pgTable("ticker_aliases", {
  alias: text("alias").primaryKey(),
  symbol: text("symbol")
    .notNull()
    .references(() => tickers.symbol, { onDelete: "cascade" }),
});

// AI Brief — resumen accionable del día generado por LLM (task="brief" en
// lib/providers/openrouter.ts). Se regenera cuando el último tiene >4h;
// el dashboard muestra siempre el más reciente.
export const aiBriefs = pgTable("ai_briefs", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(), // markdown-lite (bullets)
  model: text("model").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Ticker Day Brief — resumen LLM de "qué está pasando HOY" para un símbolo
// concreto (página /ticker/[symbol]). Se genera on-demand al visitar la
// página y se cachea aquí; `newestNewsAt` guarda el publishedAt más reciente
// de las noticias usadas como input, para invalidar el caché solo cuando
// hay cobertura nueva (y no quemar cuota regenerando lo mismo).
export const tickerBriefs = pgTable(
  "ticker_briefs",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol")
      .notNull()
      .references(() => tickers.symbol, { onDelete: "cascade" }),
    content: text("content").notNull(), // markdown-lite (párrafo lead + bullets)
    model: text("model").notNull(),
    newsCount: integer("news_count").notNull(),
    newestNewsAt: timestamp("newest_news_at", { withTimezone: true }),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ticker_briefs_symbol_generated_idx").on(t.symbol, t.generatedAt)],
);

// AI Picks — "qué stocks comenta hoy el tape como buenas inversiones".
// Agregado 24h de cobertura bullish (upgrades, beats, sentimiento alto) →
// el LLM selecciona 3-6 y redacta la tesis de cada uno. `content` es un
// JSON array de picks ({symbol, thesis, catalysts, caution?}) validado por
// código antes de insertar. Misma cadencia y patrón que ai_briefs.
export const aiPicks = pgTable("ai_picks", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(), // JSON array de TickerPick
  model: text("model").notNull(),
  newsCount: integer("news_count").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Próximos earnings de los símbolos en watchlist (Finnhub earnings
// calendar, horizonte 90d). Cache-tabla refrescada ~1/día por símbolo
// desde cron-runner + refresh-once — la UI SIEMPRE lee de aquí, nunca de
// Finnhub directo (0 llamadas por pageview). Fechas como text ISO
// yyyy-mm-dd (sortable); estimaciones como text para no perder precisión
// (mismo criterio que quotes_cache).
export const earningsEvents = pgTable(
  "earnings_events",
  {
    symbol: text("symbol")
      .notNull()
      .references(() => tickers.symbol, { onDelete: "cascade" }),
    date: text("date").notNull(), // yyyy-mm-dd
    hour: text("hour"), // bmo | amc | dmh | ""
    quarter: integer("quarter"),
    year: integer("year"),
    epsEstimate: text("eps_estimate"),
    revenueEstimate: text("revenue_estimate"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.symbol, t.date] }),
    index("earnings_events_date_idx").on(t.date),
  ],
);

// Author Watch — tweets crudos del autor seguido (@Couch_Investor) scrapeados
// 1×/día desde el Mac con la sesión del usuario. `tickers` = cashtags $XYZ
// que el autor mencionó (extraídos en ingesta). El brief diario los cruza
// con nuestro tape. `author` deja la puerta abierta a multi-autor sin
// migración.
export const authorTweets = pgTable(
  "author_tweets",
  {
    tweetId: text("tweet_id").primaryKey(),
    author: text("author").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    url: text("url"),
    isRetweet: smallint("is_retweet").notNull().default(0),
    tickers: text("tickers").array().notNull().default([]),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("author_tweets_author_created_idx").on(t.author, t.createdAt)],
);

// Author brief diario — la "super sección": fusión de lo que el autor dijo
// el día anterior con nuestro tape de noticias de esos tickers. content =
// JSON {intro, stocks:[{symbol, authorTake, tapeContext, divergence?}]}.
export const authorBriefs = pgTable("author_briefs", {
  id: serial("id").primaryKey(),
  author: text("author").notNull(),
  content: text("content").notNull(), // JSON AuthorBriefContent
  model: text("model").notNull(),
  tweetCount: integer("tweet_count").notNull(),
  coveredDate: text("covered_date").notNull(), // yyyy-mm-dd cubierto
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Fundamentales de FMP cacheados (tabla de cache con TTL 7d). FMP free =
// 250 calls/día, así que la UI SIEMPRE lee de aquí; solo se re-pega a FMP
// cuando la fila falta o tiene >7d (getOrFetchFundamentals). Números como
// text (evita pérdida de precisión, patrón de quotes_cache); peers como
// array de "SYM" (el nombre se resuelve aparte si hace falta).
export const tickerFundamentals = pgTable("ticker_fundamentals", {
  symbol: text("symbol")
    .primaryKey()
    .references(() => tickers.symbol, { onDelete: "cascade" }),
  marketCap: bigint("market_cap", { mode: "number" }),
  pe: text("pe"),
  beta: text("beta"),
  sector: text("sector"),
  industry: text("industry"),
  yearHigh: text("year_high"),
  yearLow: text("year_low"),
  ceo: text("ceo"),
  peers: text("peers").array().notNull().default([]),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Contenido extraído del artículo + resumen IA on-demand (2026-07-17).
// La mayoría de fuentes no traen body o traen boilerplate ("Titular +
// SiteName"), así que al expandir una card extraemos el artículo real
// (readability-lite, o parser Form 4 para sec-edgar) y generamos un
// resumen con sustancia. Una fila por noticia; status='failed' cachea el
// fallo (paywall/bloqueo) con cooldown para no re-golpear la fuente.
export const articleExtracts = pgTable("article_extracts", {
  newsId: integer("news_id")
    .primaryKey()
    .references(() => news.id, { onDelete: "cascade" }),
  status: text("status").notNull(), // 'ok' | 'failed'
  text: text("text"), // texto extraído (cap ~20k chars)
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  aiSummary: text("ai_summary"), // resumen del artículo (2-4 frases)
  aiTake: text("ai_take"), // por qué importa para los tickers
  aiModel: text("ai_model"),
  aiGeneratedAt: timestamp("ai_generated_at", { withTimezone: true }),
});

// Transacciones insider estructuradas (SEC Form 4). Una fila por línea de
// transacción del ownership XML (seq = índice dentro del filing). A
// diferencia del resto de tablas satélite, news_id NO cascadea: la purga de
// noticias es a 20 días pero el valor de esta tabla son los agregados
// 7-90d ("dónde están comprando los insiders") — tiene su propia retención.
// Números como double: aquí se agrega (SUM/AVG), no se re-muestra el
// literal exacto como en quotes_cache.
export const insiderTrades = pgTable(
  "insider_trades",
  {
    id: serial("id").primaryKey(),
    newsId: integer("news_id").references(() => news.id, {
      onDelete: "set null",
    }),
    symbol: text("symbol")
      .notNull()
      .references(() => tickers.symbol, { onDelete: "cascade" }),
    filingUrl: text("filing_url").notNull(),
    seq: smallint("seq").notNull(), // índice de la transacción en el filing
    ownerName: text("owner_name").notNull(),
    ownerTitle: text("owner_title"),
    isDirector: smallint("is_director").notNull().default(0),
    isOfficer: smallint("is_officer").notNull().default(0),
    isTenPercent: smallint("is_ten_percent").notNull().default(0),
    txCode: text("tx_code").notNull(), // P S A M F G D C J X (Form 4 table 1)
    shares: doublePrecision("shares").notNull(),
    price: doublePrecision("price"), // null en grants sin precio
    value: doublePrecision("value"), // shares × price, precalculado
    txDate: text("tx_date"), // yyyy-mm-dd del XML
    sharesAfter: doublePrecision("shares_after"),
    filedAt: timestamp("filed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("insider_trades_filing_seq_unique").on(t.filingUrl, t.seq),
    index("insider_trades_symbol_filed_idx").on(t.symbol, t.filedAt),
    index("insider_trades_filed_idx").on(t.filedAt),
  ],
);

// Participaciones >5% (SC 13D activista / SC 13G pasiva). filerName y
// percentOfClass salen del cover page por regex — best-effort, nullable.
export const fundStakes = pgTable(
  "fund_stakes",
  {
    id: serial("id").primaryKey(),
    newsId: integer("news_id").references(() => news.id, {
      onDelete: "set null",
    }),
    symbol: text("symbol")
      .notNull()
      .references(() => tickers.symbol, { onDelete: "cascade" }),
    filingUrl: text("filing_url").notNull(),
    formType: text("form_type").notNull(), // SC 13D | SC 13G (+ /A)
    filerName: text("filer_name"),
    percentOfClass: doublePrecision("percent_of_class"),
    filedAt: timestamp("filed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("fund_stakes_filing_unique").on(t.filingUrl),
    index("fund_stakes_filed_idx").on(t.filedAt),
  ],
);

// Digest IA "Smart Money" — lectura LLM de los agregados insider+fondos de
// 7 días (net buying, cluster buys, stakes nuevas). content = JSON
// InsiderDigestContent. Mismo patrón de cadencia/retención que ai_picks.
export const insiderDigests = pgTable("insider_digests", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(), // JSON InsiderDigestContent
  model: text("model").notNull(),
  tradeCount: integer("trade_count").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Signal Lab ──────────────────────────────────────────────────────────
// Cada señal que Catalyst emite queda registrada AL NACER, y un job nocturno
// la mide sola contra los precios posteriores. El registro es PROSPECTIVO
// (se escribe en el momento de la detección, nunca reconstruido a posteriori
// salvo el backfill explícito de mayo) — eso es lo que lo hace limpio de
// lookahead bias, a diferencia de un backtest.
//
// `kind` es TEXT, no enum: la fase 3 añade kinds nuevos (short_squeeze_setup,
// fund_new_position) y un pgEnum obligaría a una migración por cada uno.
// La lista viva está en lib/signals/kinds.ts.
export const signalEvents = pgTable(
  "signal_events",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    symbol: text("symbol")
      .notNull()
      .references(() => tickers.symbol, { onDelete: "cascade" }),
    // Identidad de la señal DENTRO de su kind — lo que hace el insert
    // idempotente frente a los ticks de 10min. Por kind: ai_pick → id de la
    // fila ai_picks; analyst_upgrade → newsId; stake_13d → filingUrl;
    // author_call → briefId; kinds de ventana rodante → symbol:fecha.
    refId: text("ref_id").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Precio intradía en el momento de detectar. INFORMATIVO — el retorno
    // SIEMPRE se calcula close-to-close ajustado (ver signal_outcomes), no
    // desde aquí: un precio intradía mezcla el timing con la señal.
    priceAtDetection: doublePrecision("price_at_detection"),
    meta: text("meta"), // JSON libre por kind (nº de compradores, %, tesis…)
    // Control del job de outcomes: cuántas pasadas lo han intentado y cuándo
    // fue la última. Sin esto, un símbolo deslistado (sin barras en Yahoo
    // jamás) se re-intentaría en cada tick para siempre.
    outcomeAttempts: smallint("outcome_attempts").notNull().default(0),
    lastOutcomeAt: timestamp("last_outcome_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("signal_events_kind_symbol_ref_unique").on(
      t.kind,
      t.symbol,
      t.refId,
    ),
    index("signal_events_kind_detected_idx").on(t.kind, t.detectedAt),
    index("signal_events_detected_idx").on(t.detectedAt),
  ],
);

// Retorno realizado de una señal a un horizonte. Semántica FIJA (cambiarla
// invalida las comparaciones históricas):
//   - baselineDate = día de detección si la señal nació ANTES del cierre y
//     ese día hubo sesión; si nació tras las 16:00 ET o en festivo/finde →
//     la siguiente sesión.
//   - horizon = nº de DÍAS HÁBILES (sesiones reales, tomadas de la propia
//     serie de Yahoo — así los festivos salen gratis y siempre bien).
//   - returnPct = adjclose(target)/adjclose(baseline) - 1. SIEMPRE adjclose:
//     con `close` crudo, un split 2:1 se leería como -50%.
//   - benchmarkReturnPct = lo mismo para SPY entre las MISMAS dos fechas.
export const signalOutcomes = pgTable(
  "signal_outcomes",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => signalEvents.id, { onDelete: "cascade" }),
    horizon: smallint("horizon").notNull(), // días hábiles: 1 | 7 | 30
    baselineDate: text("baseline_date").notNull(), // yyyy-mm-dd (ET)
    targetDate: text("target_date").notNull(), // yyyy-mm-dd (ET)
    baselineClose: doublePrecision("baseline_close").notNull(),
    targetClose: doublePrecision("target_close").notNull(),
    returnPct: doublePrecision("return_pct").notNull(),
    benchmarkReturnPct: doublePrecision("benchmark_return_pct"),
    filledAt: timestamp("filled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.horizon] }),
    index("signal_outcomes_filled_idx").on(t.filledAt),
  ],
);

// Embeddings del archivo para Ask Catalyst (RAG, 2026-07-21).
//
// Por qué NO cuelga de `news` con CASCADE (a diferencia de news_scores):
// las noticias se purgan a los 20 días y las CITAS de una respuesta tienen
// que seguir siendo verificables después. Por eso la fila lleva un
// SNAPSHOT desnormalizado (headline, summary, url, símbolos, fecha) y el
// FK es SET NULL — mismo patrón que insider_trades/fund_stakes. Efecto
// buscado: la ventana consultable del archivo CRECE indefinidamente en lo
// embebido, aunque la fila original ya no exista.
//
// Selectividad (free tier es ley): solo impact>=3, y solo titular+summary,
// nunca el cuerpo. Chunk = unidad semántica natural, que es justamente lo
// que el research daba como ~2× mejor que trocear por tamaño fijo.
//
// halfvec(768) = 2 bytes/dimensión (vector serían 4). ~1.5KB/fila + ~0.4KB
// de snapshot. El índice HNSW se crea en la migración a mano: drizzle-kit
// no sabe emitir opclases sobre tipos custom.
const halfvec768 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "halfvec(768)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) =>
    typeof value === "string"
      ? value.slice(1, -1).split(",").map(Number)
      : (value as unknown as number[]),
});

export const newsEmbeddings = pgTable(
  "news_embeddings",
  {
    id: serial("id").primaryKey(),
    // SET NULL, no CASCADE: al purgarse la noticia el snapshot sobrevive.
    newsId: integer("news_id").references(() => news.id, {
      onDelete: "set null",
    }),
    headline: text("headline").notNull(),
    summary: text("summary"),
    url: text("url").notNull(),
    source: text("source").notNull(),
    // Snapshot de los tickers vinculados EN EL MOMENTO de embeber. Array y
    // no columna única: una noticia toca varios símbolos y el filtro "¿qué
    // se dijo de NVDA?" tiene que verlos todos sin news_tickers, que se va
    // con la purga.
    symbols: text("symbols").array().notNull().default(sql`'{}'::text[]`),
    impact: smallint("impact").notNull(),
    sentiment: smallint("sentiment").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    embedding: halfvec768("embedding").notNull(),
    // Modelo + dimensión con los que se generó: si algún día cambia, hay
    // que saber qué filas son comparables entre sí (los vectores de
    // modelos distintos NO viven en el mismo espacio).
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Una noticia = un embedding. Los NULL (noticias ya purgadas) no chocan
    // entre sí en Postgres, que es justo lo que queremos.
    uniqueIndex("news_embeddings_news_unique").on(t.newsId),
    index("news_embeddings_published_idx").on(t.publishedAt),
    index("news_embeddings_symbols_idx").using("gin", t.symbols),
  ],
);

// Short interest consolidado de FINRA (Fase 3, 2026-07-21). Una fila por
// símbolo y fecha de liquidación; el histórico se conserva porque la GRACIA
// del dato es la tendencia entre quincenas, no la foto suelta.
export const shortInterest = pgTable(
  "short_interest",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    // FINRA publica dos liquidaciones al mes (día 15 y fin de mes). Se guarda
    // como texto YYYY-MM-DD: es la clave de partición del API y así se
    // compara sin líos de huso horario.
    settlementDate: text("settlement_date").notNull(),
    currentShortQty: bigint("current_short_qty", { mode: "number" }).notNull(),
    previousShortQty: bigint("previous_short_qty", { mode: "number" }),
    avgDailyVolume: bigint("avg_daily_volume", { mode: "number" }),
    // Days-to-cover que calcula la propia FINRA (short / volumen medio).
    // Es el eje del squeeze setup: sin float fiable y gratis, DTC es la
    // única medida de "cuánto tardarían los cortos en salir" que no nos
    // obliga a inventar el denominador.
    daysToCover: doublePrecision("days_to_cover"),
    changePercent: doublePrecision("change_percent"),
    marketClass: text("market_class"),
    issueName: text("issue_name"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Idempotencia: el cron reintenta la misma quincena sin duplicar.
    uniqueIndex("short_interest_symbol_settlement_unique").on(
      t.symbol,
      t.settlementDate,
    ),
    index("short_interest_settlement_idx").on(t.settlementDate),
  ],
);

// Lectura del comunicado de resultados (8-K item 2.02, exhibit 99.1) de las
// empresas de la watchlist — Fase 3. Es el FALLBACK pre-comprometido a los
// transcripts, que tienen copyright y fuente frágil.
export const earningsReports = pgTable(
  "earnings_reports",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    /** Nº de accession del 8-K: identidad estable del filing en EDGAR. */
    accession: text("accession").notNull(),
    filingDate: text("filing_date").notNull(),
    reportDate: text("report_date"),
    exhibitUrl: text("exhibit_url").notNull(),
    /** Titular real del comunicado (primera línea con sustancia). */
    headline: text("headline"),
    summary: text("summary").notNull(),
    /** "Lo que el management NO dijo" — la lectura entre líneas. */
    readBetweenLines: text("read_between_lines"),
    /**
     * Las dos cifras de cabecera EN UNIDADES ABSOLUTAS (1.220.000.000, no
     * "1,22B"), extraídas en la MISMA llamada que ya lee el comunicado — así
     * que su coste marginal es cero.
     *
     * `doublePrecision` y no text porque aquí SÍ se hace aritmética: la
     * sorpresa contra el consenso de `earnings_events`. Es el criterio de
     * `watchlist` — text sólo para lo que únicamente se pinta.
     *
     * `*_basis` NO es decorativo y no puede ser NULL sin consecuencia: una
     * empresa publica ingresos GAAP **y** ajustados con varios puntos de
     * diferencia (SoFi Q2-26: 1,22B GAAP vs 1,2B ajustado). Comparar la base
     * equivocada contra el consenso da un beat que parece exacto y no lo es,
     * que es la peor clase de número. Sin base declarada no se calcula nada.
     */
    revenueActual: doublePrecision("revenue_actual"),
    revenueBasis: text("revenue_basis"),
    epsActual: doublePrecision("eps_actual"),
    epsBasis: text("eps_basis"),
    /**
     * JSON con `Attribution[]` — qué se movió y a qué lo ATRIBUYE la empresa,
     * clasificado en núcleo / inversión deliberada / no recurrente. Ver
     * `lib/coach/frames.ts`.
     *
     * Es la pieza que separa "el margen baja porque el negocio se deteriora"
     * de "el margen baja porque estamos comprando el futuro" — mismo número,
     * noticia opuesta. `read_between_lines` ya OBSERVABA movimientos; esto
     * los ATRIBUYE, que es lo que permite leerlos contra el marco de la
     * posición sin inventarse umbrales.
     *
     * text y no jsonb, como `signal_events.meta`: es carga útil que se
     * serializa entera, nunca se consulta por dentro en SQL.
     */
    attribution: text("attribution"),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Un filing se lee UNA vez: sin esto el tick de 10min repetiría la
    // llamada al LLM del mismo comunicado indefinidamente.
    uniqueIndex("earnings_reports_symbol_accession_unique").on(
      t.symbol,
      t.accession,
    ),
    index("earnings_reports_symbol_filed_idx").on(t.symbol, t.filingDate),
  ],
);

// Marcas de "última vez que se INTENTÓ" de los jobs del cron. Los guards que
// miraban MAX(created_at) de su propia tabla sólo se activaban cuando había
// datos NUEVOS — con datos trimestrales (13F, earnings) eso es casi nunca, y
// el barrido "cada 12h" corría en realidad en cada tick de 10 min. También
// sirve de memoria de fallos por filing (key `earnings-fail:SYM:accession`).
export const jobState = pgTable("job_state", {
  key: text("key").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});

// CUSIP → ticker. Caché PERMANENTE: la correspondencia no cambia (un CUSIP
// identifica una emisión concreta para siempre), así que una vez resuelto no
// se vuelve a preguntar a OpenFIGI jamás. Es el "gate" que el design doc
// exigía resolver antes de tocar 13F: el information table identifica por
// CUSIP y nosotros indexamos todo por ticker.
export const cusipMap = pgTable(
  "cusip_map",
  {
    cusip: text("cusip").primaryKey(),
    // NULL = consultado y SIN equivalencia cotizada en EEUU (bonos, clases
    // no listadas). Se guarda igual para no re-preguntar en cada trimestre.
    symbol: text("symbol"),
    name: text("name"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("cusip_map_symbol_idx").on(t.symbol)],
);

// Posiciones declaradas en el 13F de los fondos curados.
export const fundHoldings = pgTable(
  "fund_holdings",
  {
    id: serial("id").primaryKey(),
    fundCik: text("fund_cik").notNull(),
    fundName: text("fund_name").notNull(),
    /** Fin del trimestre declarado (YYYY-MM-DD). La comparación entre
     *  trimestres es lo que produce la señal de posición nueva. */
    periodOfReport: text("period_of_report").notNull(),
    /** Fecha en que se PRESENTÓ (≠ fin de trimestre: el plazo son 45 días).
     *  La señal se apoya en ésta, no en el trimestre: un 13F es conocible
     *  desde que se registra, y registrar la señal por el trimestre haría que
     *  el Lab midiera retornos desde antes de que la información existiera. */
    filingDate: text("filing_date"),
    cusip: text("cusip").notNull(),
    symbol: text("symbol"),
    issuerName: text("issuer_name").notNull(),
    /** Valor en DÓLARES (desde la reforma de 2023 ya no son miles).
     *  Verificado: Ally 12.719.675 acciones → value 498.992.850. */
    value: bigint("value", { mode: "number" }).notNull(),
    shares: bigint("shares", { mode: "number" }),
    accession: text("accession").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Un fondo declara un CUSIP una vez por trimestre. El information table
    // PUEDE repetir el mismo CUSIP en varias filas (un manager distinto por
    // fila), así que la ingesta agrega antes de insertar.
    uniqueIndex("fund_holdings_fund_period_cusip_unique").on(
      t.fundCik,
      t.periodOfReport,
      t.cusip,
    ),
    index("fund_holdings_symbol_idx").on(t.symbol),
    index("fund_holdings_period_idx").on(t.periodOfReport),
  ],
);

export type FundHoldingRow = typeof fundHoldings.$inferSelect;
export type EarningsReportRow = typeof earningsReports.$inferSelect;
export type ShortInterestRow = typeof shortInterest.$inferSelect;
export type Ticker = typeof tickers.$inferSelect;
export type NewsEmbeddingRow = typeof newsEmbeddings.$inferSelect;
export type SignalEventRow = typeof signalEvents.$inferSelect;
export type SignalOutcomeRow = typeof signalOutcomes.$inferSelect;
export type NewNews = typeof news.$inferInsert;
export type NewsRow = typeof news.$inferSelect;
export type NewsScore = typeof newsScores.$inferSelect;
export type WatchlistRow = typeof watchlist.$inferSelect;
