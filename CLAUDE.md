@AGENTS.md

# Catalyst Local — project conventions

Realtime market news dashboard inspired by Catalist.Live. Free-tier-only stack.

## Stack

- **Hosting: Cloudflare Workers** via `@opennextjs/cloudflare` (migrated off Vercel 2026-07-15 — see "Hosting" below). Live at `https://catalyst-local.manubisbal19.workers.dev`.
- **Next.js 16** (App Router, Turbopack) + **React 19** + **Tailwind 4** + **shadcn/ui** (base-nova preset)
- **Drizzle ORM** + **Neon Postgres** via `@neondatabase/serverless`. **TWO clients (lib/db/index.ts)** — this matters:
  - `db` (global, ALL reads) = **HTTP driver** (`drizzle/neon-http` + `neon()`). Stateless: each query is an independent fetch. This is MANDATORY on Workers — a global `Pool` (WebSocket) shares an I/O object across requests in the same isolate and throws `Cannot perform I/O on behalf of a different request` intermittently (ticker pages were 500 on ~1 of every 2 loads, alternating). NEVER put a module-level Pool/WebSocket/stream back on the hot path.
  - `createTxDb()` (on-demand) = **Pool** (`drizzle/neon-serverless`) for interactive transactions only (insertNewsBatch reads an intermediate INSERT result to build the next). Node-only (cron/daemon/scripts), never the Worker; caller must `close()` in `finally`.
- **LLM stack (2026-07-16)**: OpenRouter primary → **Gemini** (Google AI Studio, `lib/providers/gemini.ts`) → Groq last resort (`SCORER_PRIMARY` env overrides the head). Gemini pool = **4 primary keys** (`GEMINI_API_KEYS`; la 4ª añadida 2026-07-21) rotated **round-robin per request** (its binding limit is RPM, not daily like OpenRouter — round-robin makes N keys ≈ N× RPM) + **1 RESERVE key** (`GEMINI_RESERVE_API_KEYS`, the user's MAIN Google account) used ONLY when every primary is cooled — minimal volume = near-human profile = smallest multi-account ban surface for the account we least want to lose. Model `gemini-3.5-flash-lite` (2.5-flash-lite is closed to new accounts; 3.1 → 3.5 el 2026-07-21), fallback `gemini-3.1-flash-lite`. **`gemini-2.0-flash-lite` salió de la cadena (2026-07-21): su free tier está a cero** y, peor, su 429 llega con quotaId `...PerDay...` → `applyRateLimit` enfriaba la KEY COMPLETA hasta medianoche Pacific por una cuota que era sólo de ESE modelo; con el bucle de modelos por fuera, un bache en el modelo de cabeza mataba las 4 keys + la reserva el resto del día. Desde el audit del swap, **el cooldown de cuota es por `(key, modelo)`** (`modelCooldowns`): agotar 3.5 en una key ya no quema 3.1 en esa key, y solo un quotaId explícito SIN `PerModel` enfría la key completa. Un modelo sin cuota en `GEMINI_MODELS` sigue siendo mala idea (una request muerta por sweep), pero ya no envenena el pool. 429s classified by `details[].violations[].quotaId` (campo autoritativo — el retryDelay del diario también pide ~2s; regex legacy solo si no viene quotaId): daily → cool until Pacific midnight (~07:05Z), RPM burst → `retryDelay`+2s. `tryTier` skip-and-continues on ANY per-key error (a hard error must not wedge the whole tier). Keys off-repo in `~/.catalyst-gemini-keys` (mode 600) + GH/Worker secrets. Every request sends thinking al mínimo, **con el dialecto de su familia** (`thinkingConfigFor`): 3.x exige el enum `thinkingLevel:"minimal"` (`"none"` no existe) y devuelve **400 con `thinkingBudget:0`**; 2.x sigue con `thinkingBudget:0`. Un 400 no es retriable, así que el payload se construye POR MODELO dentro del bucle — compartirlo entre familias tumbaría el modelo de cabeza en todas las keys. User-facing prose → `lib/ai/prose-chain.ts` (openrouter task="brief" → gemini → groq 70b → 8b). OpenRouter chains **per task** in `lib/providers/openrouter.ts`:
  - `scoring`: `nemotron-3-ultra` → `llama-3.3-70b` → `gemma-4-31b` → `nemotron-3-nano-omni-reasoning`
  - `brief` (prose): `nemotron-3-ultra` → `gemma-4-31b` → `llama-3.3-70b` → `qwen3-next-80b`
  - `author` (Author Watch daily fusion): reasoning models WITH `reasoning:true` — the ONLY chain that reasons on purpose (1 call/day makes it affordable; anti-scratchpad guard protects). Everything else sends `reasoning:{enabled:false}`.
- **Scoring is batched (v4.1)**: `scoreNewsBatch()` sends up to 10 news/call, returning per-item scores + `wrong_tickers` + a plain-English **`summary`** for impact>=4 items only (the per-item AI summary — same call, ~0 marginal cost; `news_scores.summary`, shown in the expanded card). Don't revert to 1-call-per-news. The picker (`lib/cron/score-orphans.ts`, **v4.2**) is **hybrid**: 2/3 newest DESC + 1/3 mid-band (>24h old, also DESC — recency-first; the 5-day purge, not the picker, releases the tail). Pick+claim is ONE atomic `UPDATE…RETURNING` on `news.claimed_at` (10-min TTL) so GH cron + local scorer + manual drains never double-score the same items. Skips `scoring_attempts>=5` (abandoned) and `published_at` older than 5 days. Unscored news >5 days is purged (`deleteUnscoredOlderThan`, UNSCORED_RETENTION_DAYS); scored news lives to 20 days. **An LLM 200-response with empty content is a retriable error** (openrouter + gemini) — treating it as success short-circuits the fallback chain (2026-07-17 incident).
- **Article extraction + per-item AI summary (2026-07-17)**: expanding a card
  fetches `GET /api/article/[id]` → `lib/articles/enrich.ts` extracts the real
  article (`lib/articles/extract.ts`, dependency-free readability-lite,
  Workers-safe) and generates `{summary, take}` via prose-chain (jsonMode),
  cached in `article_extracts` (failures cached 6h). Google News URLs
  (rss:marketbeat + all gnews:*) resolve via the batchexecute signature
  technique; SEC Form 4 parses the raw ownership XML into readable
  insider-transaction text — never feed the xsl-rendered .htm to the parser.
  Hard-blocked sources (seekingalpha, investing.com, tipranks — 403 to any
  non-browser; finnhub's `api/news?id=` redirector 404s) degrade to the
  provider body (≥180 chars) or an honest paywall message in the UI.
  score-orphans pre-enriches fresh impact>=4 items (`ENRICH_BATCH`, default 4).
  **No subir `ENRICH_BATCH` para tener más cuerpos**: ese camino llama a
  `getArticleDetail` SIN `allowLlm:false`, así que cada artículo cuesta una
  llamada de prosa, y lo que las decisiones de /ask leen es `text`, no el
  resumen. La palanca correcta es `prewarmPortfolioBodies` (abajo), que
  extrae cuerpos a coste cero de cuota.
- **Pusher Channels** for realtime broadcast to clients
- **News sources (6)**: Finnhub (general + per-company), Marketaux, RSS aggregator, Google News per-ticker, and **SEC EDGAR** (`lib/providers/sec-edgar.ts` — 8-K + Form 4 + **SCHEDULE 13D/13G**, CIK→ticker via official `company_tickers.json`, filtered to `knownSymbols`, Node-only). ⚠️ EDGAR gotchas: the modern form type is `SCHEDULE 13D` (`SC 13D` returns 0 entries from getcurrent); 13D/G entries appear TWICE — "(Subject)" and "(Filed by)" — and the Filed-by entry must be skipped or a stake gets attributed to the FUND's ticker. Quotes/search via Finnhub; historical bars via Yahoo.
- **Insider & Smart Money (2026-07-20)**: structured SEC data behind `/insider`. `lib/insider/ingest.ts` (Node-only, runs inside refresh-news) parses Form 4 ownership XML → `insider_trades` (one row per transaction) and 13D/G cover XML → `fund_stakes` (filer + % of class; both fields best-effort nullable — `<filingPersonName>`/`<classPercent>` can contain free-text paragraphs, a valid name is ≤80 chars). Self-healing: picks up DB filings with `news.insider_parsed_at IS NULL` (72h lookback), marks the attempt ALWAYS (also on failure). These tables do NOT cascade from news (SET NULL) and have their own retention (90d trades / 180d stakes) — the value is 7-90d aggregates, news purges at 20d. Flow aggregates (`lib/insider/queries.ts`, Workers-safe reads) count ONLY open-market P/S codes — grants (A), option exercises (M) and tax-withholding (F) are stored but excluded from "where insiders are investing". AI digest every 6h: `lib/ai/insider-digest.ts` (tag "insider", same maybeGenerate*/SKIP_BRIEFS pattern as brief/picks). Backfill: `scripts/backfill-insider.ts`.
- **AI Picks v2 = momentum building, not today's winners.** Candidates come from a 72h signal window vs a prior-week baseline (coverage acceleration), enriched with insider net buying (7d), next earnings ≤21d (only what's cached in `earnings_events`) and today's % move. Already-moved names (>6% today) are pushed to the end of the prompt and must carry a `caution` if kept. Output shape `{symbol, thesis, momentum, catalysts, watch_for?, caution?}` — `watch_for` only when the data names a concrete trigger. Don't revert the candidate SQL to a 24h bullish-hits window: that selects what already exploded (the v1 failure mode).
- **Signal Lab (2026-07-21)** — `/lab`, the track record of Catalyst's OWN signals. `lib/signals/`: `detect.ts` registers a `signal_events` row the moment a signal fires (every cron + refresher tick, no LLM), `outcomes.ts` measures it later against prices. **The registry is prospective and never revised** — that's what keeps it free of the lookahead bias that contaminates LLM backtests, so don't add a path that rewrites or re-scores past events.
  - **Double idempotency**: `UNIQUE(kind, symbol, ref_id)` stops the 10-min tick duplicating the same signal; a per-kind **cooldown** (`lib/signals/kinds.ts`) stops the same *story* entering under a new refId. AI Picks regenerates every 4h — without the 3d cooldown one stock would count as ~6 independent observations a day and inflate N with near-duplicates.
  - **Return semantics are FIXED** (changing them invalidates every historical comparison): close-to-close on **adjusted** closes; baseline = first actionable session (same day if the signal fired before 16:00 ET, else the next session); horizons 1/7/30 are **trading days counted as positions in the real session series**, so market holidays are handled with no calendar of our own; benchmark = SPY over the exact same two dates. `price_at_detection` is informative only and must never become a return denominator.
  - **Prices** (`lib/signals/prices.ts`): Yahoo direct → **Yahoo via our own Worker** (`/api/adj-closes`) → FMP `historical-price-eod/dividend-adjusted`. **Yahoo rate-limits by IP and the split is asymmetric** (verified 2026-07-21): 429 to everything from the user's Mac *and* from GitHub Actions runners, but normal service from Cloudflare Workers. Since the outcomes job runs in the GH cron, it asks our Worker for the prices (`LAB_PRICE_PROXY_URL`) — free, no new account or key. The FMP fallback is **off by default** (`LAB_FMP_MAX_CALLS=0`, per-process budget vs a 250/day quota shared with fundamentals) and its free plan **doesn't cover the whole universe** — 402 "not available under your current subscription" on RKLB/ASML/GOOG while serving AAPL/TSM/GOOGL/SPY. **Stooq is not an option**: it now serves a JS proof-of-work challenge (fragile scraping).
  - The job is chunked + resumable with a time budget: one price call per SYMBOL (not per event×horizon), each event retried at most 1×/20h, abandoned after 10 dataless days. The attempt counter **resets on any successful fill**, so a healthy event is never abandoned while waiting for its 30d horizon.
  - **Empirical priors** (`priors.ts`) feed `PICKS_SYSTEM_PROMPT` and the insider digest: the track record returns to the generator as *calibration of how demanding to be*, only above n≥20, and the prompt forbids quoting the numbers or presenting them as a forecast. Backfill: `pnpm signals:backfill` (`--dry-run` / `--no-outcomes`); manual measurement: `pnpm signals:outcomes`.
- **Ask Catalyst (2026-07-21)** — `/ask`, preguntar al archivo con citas. `lib/embeddings/ingest.ts` (Node-only, corre dentro del tick de score-orphans) embebe las noticias impact≥3 en `news_embeddings`; `lib/ask/retrieve.ts` recupera y `lib/ai/ask.ts` redacta.
  - **La tabla NO cascadea de `news`** (FK `SET NULL` + snapshot desnormalizado headline/summary/url/symbols/fecha). Las noticias se purgan a 20d y las citas tienen que seguir siendo verificables: la ventana consultable **crece sola** en lo embebido. Retención propia (`EMBED_RETENTION_DAYS`, **60d** — medido 2026-07-21: ~4,5 kB/fila con HNSW; 90d cruzaría el guard de storage hacia el día ~65), salvo lo que originó una señal `analyst_upgrade` del Lab (la comparación de `ref_id` va filtrada por kind — es un campo polimórfico y sin el filtro un id de `ai_picks` preservaría una noticia ajena), que no se purga nunca. **Único escritor**: el scorer local lleva `EMBED_ENABLED=0` en su plist — el pick de embeddings no tiene claim atómico y dos escritores pagan la cuota doble.
  - **Retrieval híbrido de 3 canales**, y el tercero no es opcional: vectorial (pgvector, encuentra por significado) + léxico ILIKE (literales, y ÚNICO canal para anónimos porque no gasta cuota) + **agregados SQL** (insider neto, 13D/G, earnings, último pick). El research del design doc es explícito: **el RAG vectorial falla justo en lo numérico**, así que ningún número de una respuesta sale de un embedding.
  - **Gating igual que `/api/article`**: sólo la sesión del dueño embebe la pregunta y llama al LLM. Anónimo en el Worker = léxico + SQL, cero cuota. Si la cuota de embeddings se agota, degrada a léxico en vez de fallar. `hasCoverage` corta ANTES de la llamada LLM: con facts siempre pasa; sin ticker exige ≥2 citas vectoriales a distancia coseno ≤`ASK_MAX_DIST` (0.62, calibrable por env mirando `dist` en las citas).
  - **Cuota de Gemini embeddings, medida 2026-07-21** (Google ya no la publica): `gemini-embedding-001`, **100 embeddings/min y key** y **1.000/día y key** (reset a medianoche Pacific), y en `batchEmbedContents` **cada TEXTO cuenta como una request** — el batch ahorra latencia, nunca cuota. El diario se midió contando filas por día Pacific: exactamente 3.000 (= 3 keys × 1.000) con parón en seco; ese 3×1.000 confirma que las keys están en proyectos distintos y que el round-robin sí suma. Con la 4ª key (2026-07-21) el techo teórico es 4.000/día — pendiente de OBSERVAR un día completo antes de darlo por bueno (si la key comparte proyecto con otra, no suma diario, solo RPM). La ingesta se autolimita a `EMBED_DAILY_BUDGET` (2.500 por defecto) contando filas por día Pacific, reservando el resto para preguntas de /ask — subirlo solo tras confirmar el techo real. Régimen normal ~400-900 impact≥3/día → cabe con holgura.
  - **Nunca pedir un lote de 100**: el tope de batch de la API coincide con el límite por minuto, así que un lote de 100 sólo entra con el cubo intacto y basta una pregunta de `/ask` en esos 60s para tumbarlo entero (y el mismo lote se reenviaba a las 3 keys, quemándolas). Se trocea a `EMBED_CHUNK` (50) insertando por trozo → tick resumable.
  - **Un 429 se clasifica por `details[].violations[].quotaId`, jamás por el tamaño de `retryDelay`**: el límite DIARIO llega pidiendo "retry in 2.35s", idéntico a una ráfaga por minuto. Confundirlos enfría 2s una pared de 24h y el pool se pasa el día reintentando en silencio (pasó el 2026-07-21: 2h de ingesta parada, sólo visible como `embedAgeMin` creciendo en `/api/health`).
  - Con `outputDimensionality<3072` el vector **no viene normalizado** (norma ~0.6): se normaliza en el cliente. `lib/providers/gemini-embed.ts` comparte las keys del pool de chat pero tiene **cooldown propio** — la métrica de cuota es otra y un 429 aquí no debe dejar al scorer sin esa key.
  - **Neon free = 512 MB para TODA la base** y los embeddings son lo primero que puede comérselos: la ingesta se pausa sola por encima de `EMBED_MAX_DB_MB` (380) y `/api/health` expone `storage`. Kill-switch: `EMBED_ENABLED=0`. Backfill: `pnpm embed:backfill` (`--dry-run`).
  - **Extraer tickers de una PREGUNTA no es lo mismo que de un titular**: un candidato sólo cuenta si viene ya en mayúsculas o con `$`. Pasar cada palabra a mayúsculas hacía que "qué se dijo DE AI chips ESTA semana" consultara Deere, Establishment Labs y Sea Ltd, con sus agregados SQL incluidos. Esa guarda cubría SÓLO el canal de mayúsculas; el de **alias entraba sin filtro** y "¿es buena IDEA dejar correr $MSFT…?" consultaba también IACO (alias "Idea"). Desde 2026-07-30 los n-gramas de UNA palabra pasan por `isCommonWord` = `COMMON_WORD_DENYLIST` (la fuente única del proyecto — no forkarla) + `DECISION_NOISE` + stopwords.
- **Ask en modo DECISIÓN (2026-07-30)** — `/ask` distingue dos clases de pregunta y **la intención manda sobre el material**. Preguntar "¿dejo correr $MSFT o vendo una parte?" devolvía un párrafo genérico, y no por el modelo: `ASK_BASE_RULES` define al redactor como *bibliotecario del archivo con prohibición de opinar*, así que la única salida compatible con el prompt era describir el valor. `lib/ask/intent.ts` clasifica; `lib/ask/decision.ts` calcula; `ASK_DECISION_PROMPT` redacta.
  - **La clasificación es una CONJUNCIÓN**: verbo de acción sobre una posición **y** (primera persona **o** petición explícita de juicio). Con sólo el verbo, "What are insiders buying lately?" —pregunta de ejemplo de la propia UI— entraba en modo decisión y contestaba con bloques de aguantar/recortar sobre unos insiders que no son el usuario.
  - **`/ask` lee la CARTERA** (`buildPortfolio`, la única fuente de estas cuentas en el proyecto). Sin peso ni P&L, "vender una parte" no tiene referente y la respuesta sólo puede ser genérica. Los precios van EN VIVO y en paralelo al retrieval; si Finnhub falla se degrada a `null` y se responde sin exposición, nunca con un peso de ayer.
  - **Las PRESIONES traen el lado asignado por código**, no por el modelo: es justo donde improvisaría. Sólo entra lo que alguien tuvo que declarar (SEC, FINRA, calendario) o la aritmética de la cartera — **cobertura y sentimiento medio quedan fuera a propósito**: con "mucha atención mediática" se justifica cualquier postura. Umbrales en `DECISION_THRESHOLDS` (peso 25%, plusvalía 40%, evento ≤14d, insider 1M$): son tolerancia al riesgo, no hechos, y se tocan ahí.
  - Una plusvalía grande es `neutral` a propósito: es argumento de los dos bandos y darle lado sería la opinión disfrazada de dato. **`buildDecisionFacts` itera SÍMBOLOS, no contextos** — recorrer los contextos dejaba fuera insiders, 13D y calendario justo el día que el proveedor de precios fallaba, sin ningún error a la vista.
  - **DOS llamadas encadenadas, no una** (2026-07-30), igual que la revisión de cartera y por el mismo motivo medido: con una sola, el modelo resume titulares por gradiente natural y ninguna instrucción del prompt lo evita de forma fiable. La 1ª (`extractForwardLedger`, reutilizada tal cual) sólo EXTRAE compromisos sin resolver a un esquema donde "la acción cayó" no cabe en ningún campo; la 2ª redacta con ese libro **delante de las noticias** (el orden importa: un modelo pondera lo que lee antes). `ledgerCandidates` arma la entrada desde las CITAS y no desde los candidatos prospectivos — los cuerpos se cosechan sobre las citas, así que los candidatos van con el cuerpo viejo (ahí es donde la revisión necesita `reloadBodies`), y en /ask también traen cuerpo las citas vectoriales y léxicas. Si la 1ª falla, la 2ª sigue con lo estructural. **Coste real medido: ~33s frente a ~11s** y el doble de cuota de prosa; sólo en decisiones. El `ledger` se devuelve FUERA de la prosa para que la UI lo pinte aunque el redactor falle.
  - **Precalentado de cuerpos (`lib/cron/prewarm-portfolio.ts`), ampliado 2026-07-30** para servir también al libro de futuros. Cambios y su porqué medido: (a) **toda la watchlist**, no sólo `shares>0` — "¿entro en $X?" es una pregunta legítima sobre un nombre que se sigue sin tener, y el filtro anterior la excluía por definición; las vivas van primero y **la prioridad se reimpone en TS** porque la consulta externa de `selectForwardCandidates` no lleva `ORDER BY` y el orden entre símbolos que devuelve Postgres es arbitrario. (b) **`perSymbol` 4 → 20**: ÉSE era el cuello de botella, no el techo de fetches — con 4 había 28 candidatos de los que sólo 5 estaban sin cuerpo mientras 2.084 noticias de esos mismos símbolos no tenían ni fila en `article_extracts`. (c) **los fallidos van al final**: `hasExtract` sólo mira `status='ok'`, así que "nunca se intentó" y "la fuente bloquea" entran indistinguibles, y los 78 fallidos (29% de los intentos) reocupaban los 24 huecos de cada pasada — la primera ejecución real dio `harvested: 0` de 5 por esto. (d) guard de almacenamiento propio a 360 MB, por debajo del de embeddings (380): si un día hay que elegir, gana la ventana consultable sobre la comodidad del cuerpo precargado.
  - **Efecto medido**: la misma pregunta de decisión sobre $RKLB pasó de **32,7s a 6,7s** con idéntico libro de futuros — los cuerpos ya estaban y la cosecha en caliente no tuvo que gastar su presupuesto de 14s. Coste en disco: ~4 kB/fila, ~0,2 MB/día en régimen, y `article_extracts` cascadea con la purga de news a 20d, así que se estabiliza sola en torno a 5-10 MB (BD medida antes de tocar nada: 216,8 MB de 512).
  - **Gate de la postura EN CÓDIGO**: sin cita usada ni hecho duro, la sección `stance` se borra y la cobertura baja a `partial`. Mojarse sin respaldo es el fallo simétrico al que abrió la sesión. Y `cleanBrackets` borra todo corchete que no sea un número de cita: dado el bloque de posición, el modelo cerraba tres de cinco secciones pegando la línea entera entre corchetes, que se lee como fuente verificable siendo el propio prompt devuelto.
  - El canal prospectivo (`selectForwardCandidates`, peso de CATEGORÍA) se enciende sólo aquí. `pendingDeals` se **filtra con `mentionsTicker` + `looksLikeDeal`**: levanta toda noticia MA ligada al símbolo y de 12 "operaciones pendientes" de MSFT la mayoría eran de terceros ("Will SpaceX buy Tesla?"); de las 4 de RKLB, dos eran "Shares Are Plunging Today" y "Stock Slides 12%" — que además metían por la puerta de atrás el movimiento de precio que el prompt prohíbe. La etiqueta dice "no verificado que siga abierta" porque **nadie lo ha comprobado**: eso sólo lo hace el extractor LLM del libro de futuros, que este camino no usa.
  - **Datos que ya estaban en la BD y esta superficie no leía** (conectados el mismo día): `ticker_fundamentals.beta` (un 27% con beta 1,9 no es el mismo 27% que con 0,8 — presión de recorte sólo si la posición se tiene), `short_interest.days_to_cover` con su DERIVADA entre liquidaciones de FINRA (**neutral a propósito**: apuesta contraria acumulada y combustible de squeeze son la misma cifra, y darle lado sería elegir narrativa), la **concentración SECTORIAL** de `buildPortfolio` (recortar un 27% suena a reducir riesgo, pero si el sector pesa el 70% vender para comprar otra tecnológica deja la exposición donde estaba) y los **priors empíricos del Lab** como calibración de cuánto exigir. Ninguno es un precio: no repiten lo que el usuario ya ve en su bróker, que es la regla que gobierna todo el modo. Coste: 2 queries más, cero cuota FMP (`ticker_fundamentals` está cacheada a 7d — NUNCA disparar una llamada a FMP desde una pregunta).
- **Cartera (2026-07-25)** — `/portfolio` es la vista de gestión (tabla con acciones, precio de entrada, precio actual, % y **$ de hoy**, invertido, valor, P&L y peso, más totales); el rail de la watchlist sigue siendo la vigilancia de reojo y sólo muestra peso y P&L. El editor admite **dos modos de entrada**: acciones o **importe invertido** (`sharesFromAmount(importe, precio) → shares`), porque una posición se recuerda como "metí 500 a 120" y no en número de acciones; el esquema sigue guardando `shares` + `avg_cost` como forma canónica — un importe suelto no permite recalcular valor ni P&L cuando el precio se mueve. `dayChangeAbs` usa el `prevClose` DECLARADO por la fuente y sólo lo deriva del porcentaje si falta: Finnhub redondea `dp` a 2 decimales y ese error se multiplica por el nº de acciones. El total en dinero es suma directa (el peso ya está dentro del importe); el porcentual sí va ponderado. `buildPortfolio` es la ÚNICA fuente de estas cuentas para las tres superficies (tabla, rail, prompt de la revisión) — si alguna hiciera las suyas, la pantalla y el modelo acabarían diciendo pesos distintos del mismo valor.
- **Reforzar posición (2026-07-30)** — botón `+` en cada fila de `/portfolio`, al lado del lápiz. Registra una COMPRA ("2 acciones a 531,26"), no un estado, y la posición se recalcula sola. Es otra operación que el editor: el lápiz corrige lo registrado, el `+` añade lo ejecutado; los dos formularios se excluyen en la misma fila porque guardar en el equivocado sobrescribe la posición entera. `addToPosition` (`lib/portfolio.ts`) es la ÚNICA definición de la media ponderada y la usan LAS DOS puntas — la previsualización del formulario y la escritura en BD—, que es lo que impide que la pantalla te prometa un coste medio y la fila guarde otro. `PATCH /api/watchlist` distingue las dos operaciones por la presencia de `add`; el cliente manda la compra y **el servidor lee la posición actual y calcula**, porque si el cliente mandara el total ya recalculado dos pestañas se pisarían y una compra desaparecería sin rastro. Guarda optimista con `IS NOT DISTINCT FROM` (no `=`: los dos campos son NULLABLE y con `=` una fila sin coste no casaría nunca consigo misma) → **409 sin reintento automático**, porque reintentar sobre el estado nuevo podría duplicar una compra que ya entró.
  - **El caso que define la feature**: si la posición tiene acciones pero **sin coste registrado** (estado válido y admitido), el coste medio resultante es **desconocido** y se guarda `null`. La tentación es poner el precio de la compra nueva; sería afirmar que pagaste ese precio también por las acciones viejas, y ese número no se queda quieto — alimenta P&L, pesos, plusvalía y las presiones que deciden si /ask te dice que recortes. La UI lo DICE en vez de enseñar un guion mudo. Sin acciones previas (`null` o `0`) sí se puede afirmar: no hay historia cuyo coste se desconozca.
- **Recortar posición + diario de operaciones (2026-07-30)** — botón `−` junto al `+`, y `position_trades` como registro append-only.
  - **VENDER NO MUEVE EL COSTE MEDIO** (`reducePosition`). Es la regla que más se incumple a mano: parece que vender caro "sube tu precio medio" y es falso — las acciones que quedan las pagaste igual que antes. Lo que la venta produce es **P&L REALIZADO**, que es otra magnitud y vive en el diario. Mover la media al vender contaminaría hacia adelante el P&L no realizado de lo que queda y, desde el modo decisión, la plusvalía que se le enseña al modelo. Vender todo deja `shares = 0` (cerrada, sigue vigilada), nunca `null` (nunca se tuvo). Tolerancia de 1e-9 acciones: con posiciones fraccionarias, "vender todo" tecleado a mano no cuadra al bit.
  - El realizado se calcula **contra el coste medio DEL MOMENTO** y se archiva. Recalcularlo después daría otro número porque una compra posterior habrá movido la media, y esa diferencia no sería una corrección sino una falsificación de lo que ganaste ese día. Sin coste registrado el realizado es `null`, nunca 0 — cero sería una afirmación.
  - **`position_trades` NO es la fuente de verdad y no debe llegar a serlo**: `watchlist.shares`/`avg_cost` siguen siendo canónicos (~8 consumidores leen de ahí y derivar el estado sumando el log obligaría a recorrerlo entero en cada lectura). Es el DIARIO: para auditar, no para calcular. Guarda el estado RESULTANTE porque el coste medio de una compra depende del anterior — sin la foto de después, una fila suelta no se puede verificar sin reproducir todo el historial, y el historial empieza el día que se creó la tabla.
  - **Las correcciones a mano se anotan como `adjust`**, o el diario mentiría por OMISIÓN: las acciones saltarían entre dos filas sin operación que lo explique y el lector supondría que falta una compra. `adjust` no lleva cantidad ni precio (no es una compra ni una venta, es un estado nuevo declarado) y **no lleva guarda optimista**: el editor manda valores absolutos, que es una orden deliberada y debe ganar.
  - **Posición y diario se escriben en UNA sentencia** (CTE `WITH upd AS (UPDATE … RETURNING) INSERT … SELECT FROM upd`). No es lucimiento: la ruta corre en el Worker, donde el Pool de `createTxDb` está PROHIBIDO, así que no hay transacción interactiva. Con dos sentencias, un fallo entre medias deja la posición movida sin línea de diario, y un diario que no cuadra es peor que no tenerlo porque invita a confiar en él.
  - Vender de más devuelve **422, no 400**: la petición está bien formada, lo que no cuadra es el saldo — y la respuesta incluye cuántas acciones hay para que el cliente lo diga.
- **Caja del diario y P&L realizado (2026-07-30)** — dos casillas más en los totales de `/portfolio` y el diario visible SIEMPRE (antes sólo se pintaba con el formulario `+`/`−` abierto, así que registrar una venta no movía nada en pantalla y el dinero desaparecía sin explicación). `journalCash()` en `lib/portfolio.ts` es la única definición de estas cuentas. **`realized` es `number | null`, no `number`**: si ninguna venta pudo medirlo (posiciones sin coste registrado), cero afirmaría "no ganaste nada" cuando la verdad es "no se sabe" — misma regla que `avgCost: null` en `addToPosition`. Y **el tipo OBLIGA a devolver `since`**: no es informativo, es lo que impide leer la caja como el saldo del bróker, al que le faltan ingresos, retiradas, dividendos, comisiones y todas las compras anteriores al diario. `adjust` no mueve caja (es un estado declarado, no dinero que cambie de sitio) pero su realizado, si lo tuviera, sí contaría: son magnitudes independientes.
- **Coach de inversión (2026-07-30)** — panel en `/portfolio`. Contrasta **lo que escribiste al operar** con **lo que se movió** y **a qué lo atribuye la empresa**, leído contra el marco declarado. `lib/coach/` + `lib/ai/falsifiers.ts`.
  - **NINGÚN DETECTOR POR UMBRAL PUEDE FUNCIONAR AQUÍ, y el contraejemplo es el caso normal.** META Q2-2026 (8-K real): margen operativo 31% vs 43% (−12pp) y capex 16,5 → 30,1 mil M$ porque compra infraestructura de IA mientras el núcleo crece. Un umbral sobre el margen dispara "tesis en riesgo" estando **exactamente al revés**: ese estrechamiento ES la tesis ejecutándose. La diferencia no está en el número sino en la CAPA que se movió (`nucleo` / `inversion` / `no_recurrente`) y en qué clase de empresa crees tener. No calibrar el umbral: no hay umbral.
  - **`watchlist.frame`** (`power_play` | `compounder` | `turnaround` | `ciclica`) decide qué es ruido y qué es mortal: `capex_disparado` es `esperado` en una power play y `mortal` en un compounder — un compounder que de pronto necesita capex pesado ha dejado de serlo. Va en la POSICIÓN, no en la operación: el marco pertenece a la empresa. **`severityOf(null, …)` devuelve `null` y NO un default** — cualquier valor leería mal media cartera; y una señal no listada cae en `vigilar`, **nunca en `esperado`** (callar sobre lo desconocido es tranquilizar sin base). El test que fija esto es `tests/coach-frames.test.ts`: dos aserciones que EXIGEN estar en desacuerdo, y si convergen el detector ha vuelto a ser un umbral.
  - **`position_trades.horizon` es OBLIGATORIO al operar** porque lo consume el código: `verdictHorizonsFor('largo')` devuelve lista vacía, así que una compra por fundamentales a años NO puede recibir un "error" por caer un 4% en tres semanas. Es una rama de código, no una instrucción del prompt. `annotated_later` es un booleano **declarado**, no una comparación de fechas a ojo: una tesis escrita sabiendo el resultado no es una predicción, y sin esa marca el sesgo retrospectivo entra disfrazado de criterio.
  - **`earnings_reports.attribution`** — el extractor ya OBSERVABA movimientos (`read_between_lines`); ahora los ATRIBUYE con la cita del management. Dos bugs medidos al montarlo: (a) `extractSecExhibitText` cortaba a **14.000 chars** y el comunicado de MSFT tiene 23.066 — se perdía el 39% con la línea "Additions to property and equipment" (char 18.606), y **el fallo no daba error: devolvía `[]`, indistinguible de un trimestre tranquilo**; ahora la ruta de earnings pide 24.000. (b) **el vocabulario estaba SESGADO**: los nombres de señal suenan a acusación, así que un comunicado titulado "Cloud and AI Strength Fuels Results" no mapeaba a `capex_disparado`; hubo que decir en el prompt que no son acusaciones y que un comunicado triunfal es el sitio MÁS probable donde encontrarlo. Con los dos arreglados, MSFT pasó de `[]` a capex 17,1 → 35,8 mil M$ + núcleo −4%.
  - **`thesis_falsifiers` es la ÚNICA puerta a un veredicto duro.** Los propone el LLM desde tesis + marco y **el usuario los aprueba**: pedirlos en frío empobrece la tesis (una convicción es un cómputo de muchas cosas), pero darlos por buenos convertiría el criterio del modelo en el suyo. El prompt de propuesta tiene que decir explícitamente que **para una power play el capex pesado ES la tesis, no un falsador** — sin eso propone que estás equivocado por tener razón. Al comprobar, **un `occurred: true` sin cita se degrada a `false` en código**: el modelo puede convencerse de que algo pasó, pero no inventarse una frase del documento y sobrevivir a que la leas. `checked_accession` hace la comprobación idempotente (un filing se paga UNA vez por símbolo, no una por visita).
  - **`trade_outcomes` reutiliza `findBaselineDate` y `horizonReturn` del Signal Lab** en vez de reimplementarlas: comparar tus decisiones con las señales de Catalyst sólo tiene sentido si la aritmética es la misma, y la del Lab está congelada. Encaja sin adaptarla porque la pregunta resulta ser la misma (el primer cierre observable DESPUÉS del momento). Tabla aparte y **no un `kind` más de `signal_events`**: los priors del Lab alimentan `PICKS_SYSTEM_PROMPT` y las decisiones humanas contaminarían ese track record.
  - **Reparto de cuota, deliberado**: `/api/coach` **no llama a ningún proveedor** (el contraste está hecho de cosas que ya son ciertas — tu texto, una cita, una tabla en código —, así que se ve con la cuota agotada); proponer falsadores pasa por el gate de `/ask`; comprobarlos vive en el cron-runner. Los comunicados son trimestrales, así que eso no retrasa nada.
- **Revisión de cartera (2026-07-25)** — `/ask`, botón *Revisar*. La watchlist es también la cartera (`watchlist.shares` / `avg_cost`, ambas NULLABLE: NULL = solo seguimiento, 0 = cerrada, >0 = viva; se amplió esa tabla y no se creó `positions` porque ~8 consumidores ya leen de ella). `lib/portfolio.ts` (TS puro, compartido por el rail cliente y el retrieval servidor) + `lib/ask/portfolio.ts` + `lib/ask/forward.ts` + `lib/ai/forward-ledger.ts` + `lib/ai/portfolio-review.ts`.
  - **DOS TRAMPAS MEDIDAS que hacían que la revisión leyera lo obvio** ("la acción cae un 8%") y que es trivial reintroducir:
    1. **Ordenar las citas por `impact DESC`**. El scoring de impacto premia POR DEFINICIÓN lo que ya movió el precio, así que la cita [1] de una posición que cae es la caída. El canal prospectivo ordena por **peso de CATEGORÍA** (`MA` 10 > `GUIDANCE` 9 > `REGULATORY` 8 > … > `OTHER` 1) y sólo después por recencia; el impacto es el ÚLTIMO desempate.
    2. **El 97% de las noticias NO tiene cuerpo extraído** (medido: META 26 de 785 en 14d; PLTR 1 de 258) porque `article_extracts` se rellena al hacer clic o a `ENRICH_BATCH`=4 por tick. Sin cuerpo el modelo redacta desde TITULARES, y un titular es lo obvio. La revisión **paga por extraer** con `harvestBodies` (fetch + cache) y presupuesto de pared de 20s. Tras la cosecha: 22/28 candidatos con cuerpo. ⚠️ **`allowLlm:false` NUNCA significó cero llamadas LLM** y esta línea lo afirmaba: el re-scoring desde texto completo (`maybeRescore`) cuelga de su propio interruptor (`RESCORE_ON_EXTRACT`) y se colaba en TODA cosecha masiva — medido el 2026-07-30, ~10 re-scorings por pasada de 24 artículos, casi todos de piezas de hasta 20 días que volvían con `impact 1`, gastando la cuota del MISMO pool que puntúa las noticias frescas (ese día ya en `HIT DAILY CAP`) y comiéndose el presupuesto de pared de la pregunta. Desde entonces `harvestBodies` pasa `allowRescore:false` — es el sitio correcto porque sus TRES consumidores son masivos (precalentado, revisión, /ask). El click sobre una tarjeta (`/api/article/[id]`) sigue re-puntuando: es un artículo, lo pidió alguien, y el titular críptico es justo el caso que lo justifica.
  - **Dos llamadas LLM encadenadas, no una.** La 1ª (`forward-ledger`) sólo EXTRAE compromisos sin resolver a un esquema donde "la acción cayó" no cabe en ningún campo; la 2ª redacta ya sin los artículos delante. Con una sola llamada el modelo resume titulares por gradiente natural y ninguna instrucción del prompt lo evitaba de forma fiable. Si la 1ª falla, la 2ª sigue con los hechos estructurales.
  - **Ningún número sale del LLM.** Beta ponderada, % de cartera que reporta el mismo día y pesos se precalculan (`deriveAggregates`) y el prompt prohíbe la aritmética: en la primera prueba real el modelo los estimaba a ojo y acertaba por poco — el modo de fallo que nadie audita.
  - **Hechos prospectivos que ya estaban en BD y nadie leía**: `earnings_events.eps_estimate`/`revenue_estimate` (la VARA a batir, no el resultado) y **vendedores sistemáticos** (≥2 ventas del mismo directivo en 90d + `shares_after` = oferta futura ya conocida; Form 4 no guarda la nota al pie del 10b5-1, el patrón repetido es su firma observable).
  - **Gate de evidencia EN CÓDIGO** (`applyEvidenceGate`), no en el prompt: una postura sin cita válida ni hecho duro declarado se degrada a `none` y se marca. La cita además tiene que mencionar ESE símbolo — sin esa comprobación el modelo colgó de META la cita del Iridium de RKLB. Los marcadores `[n]` que el modelo escribe dentro del texto se extraen, se fusionan con `used` y se limpian (si no, la UI los pintaba dos veces).
  - **Presupuesto**: 0 embeddings (los símbolos vienen de la watchlist, no hay que adivinarlos), N fetches acotados por tiempo y 2 llamadas de prosa. Lo extraído queda cacheado, así que la segunda revisión de los mismos valores empieza casi llena.
- **FMP (Financial Modeling Prep)** — `lib/providers/fmp.ts`, `/stable/` endpoints (v3/v4 are legacy, rejected for post-Aug-2025 keys). Gives P/E, beta, 52w range, peers (what Finnhub free doesn't). **Free tier 250 calls/day** → strict discipline: NEVER per-pageview, cached 7d in `ticker_fundamentals` via `getOrFetchFundamentals` (lib/fundamentals.ts). 3 calls/symbol. Key in `~/.catalyst-fmp-key` (mode 600) + GH/Worker secret.

## Commit conventions

- Commit email: `manubisbal19@gmail.com` (already set in local git config; also the Cloudflare account email)
- **NO `Co-Authored-By` trailer** — established convention for this repo
- Commit on every meaningful milestone, not in batches

## Cron strategy — DECIDED. Do not change without re-reading the post-mortem.

**The cron runs in GitHub Actions, on the runner itself. Vercel is never
invoked in the cron path.** This is the result of the 2026-05-17 Vercel
suspension post-mortem: duplicated cron + 5-min cadence + polling burned
300% of the Hobby Fluid Active CPU cap in 4 days. See
`feedback_catalyst_vercel_budget` in user memory for the full incident.

- Workflow: `.github/workflows/cron-runner.yml` runs `*/5 * * * *`
- **Real cadence**: GitHub throttles `schedule` on public repos to 1-4h, so the
  Worker `catalyst-pinger` (`scripts/pinger/`, CF Cron Trigger, free) fires a
  `workflow_dispatch` every 10 min — dispatch runs start instantly. The GH
  schedule stays as backup. Secret `GH_DISPATCH_TOKEN` = fine-grained PAT
  (Actions RW, this repo only), off-repo copy in `~/.catalyst-gh-dispatch-token`.
- Script: `scripts/cron-runner.ts` (`pnpm cron:remote`)
- The script connects directly to Neon, Pusher, Groq/OpenRouter
- `vercel.json` is intentionally empty (no Vercel crons)
- The repo is **public** so GH Actions minutes are unlimited

**Forbidden moves** (these all re-introduce the original failure):
- Re-adding any cron to `vercel.json`
- Re-creating any `app/api/cron/*` endpoint
- Re-enabling cron-job.org or any external prodder that hits Vercel
- Making the repo private without first re-budgeting the GH Actions minutes

`CRON_SECRET` is legacy — the Vercel cron endpoints were deleted on
2026-05-17. If you see it referenced anywhere outside this file, that's
dead code; remove it.

Manual trigger if needed: `gh workflow run cron-runner.yml -R manugarridoo19/catalyst-local`

## Hosting — Cloudflare Workers (migrated off Vercel 2026-07-15)

**Vercel is abandoned** (account suspended since May; not coming back). Public
site is a Cloudflare Worker: `https://catalyst-local.manubisbal19.workers.dev`.

- **Adapter**: `@opennextjs/cloudflare` (Workers with `nodejs_compat`, so
  `runtime="nodejs"` routes and the Neon driver work). NOT `next-on-pages`
  (edge-only — would break the DB). Config: `wrangler.jsonc`,
  `open-next.config.ts`, `initOpenNextCloudflareForDev()` in `next.config.ts`,
  `serverExternalPackages: ["@neondatabase/serverless"]`.
- **Deploy**: `set -a; source ~/.catalyst-cf-token; set +a; pnpm cf:build && pnpm cf:deploy`.
  ⚠️ **`cf:deploy` does NOT rebuild** — it uploads whatever is already in
  `.open-next/`. Skipping `cf:build` silently ships a stale bundle (bitten
  2026-07-16: three deploys shipped the previous day's build). Auth is a
  long-lived API token in `~/.catalyst-cf-token` (mode 600,
  `CLOUDFLARE_API_TOKEN=…`), NOT `wrangler login` (OAuth expires). Scripts:
  `cf:build` / `cf:preview` / `cf:deploy`.
- **Secrets**: on the Worker via `wrangler secret bulk` (persist across
  deploys). `.dev.vars` (gitignored) mirrors `.env.local` for local preview.
  **NEVER upload `LOCAL_MODE` / `LOCAL_DEFAULT_SESSION_ID` to the Worker** —
  they'd pin every anonymous visitor to one user's watchlist.
- Flags live only in `wrangler.jsonc` (wrangler 4.92+ rejects `--compatibility-flag` on the CLI).
- Desktop launcher: `~/Desktop/Catalyst.app` (opens localhost:3030 if the
  daemon is up, else the public URL, in Brave app-mode).

## File organization

- `/app` — Next.js App Router pages + route handlers
- `/components` — UI (feed, watchlist, ticker, search, ui)
- `/lib` — providers, db, scoring, tickers, pusher, types
- `/scripts` — local-only scripts (`run-cron-local.ts`)
- `/drizzle/migrations` — committed schema migrations
- `/tests` — vitest (TBD)

## Architecture rules

- **Universe is dynamic.** Tickers enter the `tickers` table only when a provider mentions them. Don't hardcode an SP500 list.
- **Providers must be resilient.** All cron fetches go through `Promise.allSettled` — a failing source must not tumble the cycle.
- **Scoring caps.** score-orphans picks `ORPHAN_BATCH` per tick (env-overridable, default 60, cap 300), scored in batched LLM calls of 10. The GH Actions cron sets `ORPHAN_BATCH=120` — it is ALL scoring capacity while the Mac sleeps and GitHub throttles its cadence to 1-4h. The Worker never scores — scoring lives in the GH Actions cron + the local scorer daemon.
- **Sweep guards use `job_state` (attempt time), not `MAX(created_at)` of the job's own table.** A created_at guard only engages when new data landed — with quarterly data (13F, earnings reports) that's almost never, so the "every 12h" sweep actually ran on every 10-min tick (audit 2026-07-21). `lib/cron/job-state.ts`: `jobRanWithin(key, hours)` + `markJobRun(key)`; also used as per-filing failure memory (`earnings-fail:SYM:accession`, retry every 24h) so a broken filing doesn't re-burn SEC fetches + an LLM call every sweep.
- **Liveness monitoring.** `.github/workflows/catalyst-health.yml` probes the Worker's `/api/health` every 2h; if `insertedAgeMin` or `scoredAgeMin` exceeds 300 it opens/updates a GitHub issue (label `catalyst-health`, emails the owner) and auto-closes on recovery. `/api/health` exposes `lastScoredAt`/`scoredAgeMin`/`scoredLastHour` for it. Every external fetch in the cron path MUST carry a timeout (`AbortSignal.timeout`) — a hung request eats the runner's wall-clock, and GitHub reports a timed-out job as `cancelled`, silently.
- **Ticker extraction quality.** Single-word aliases live or die by `lib/tickers/alias-denylist.ts` (SHARED by extractor match-time + enricher creation-time — never fork it back into two lists). gnews search hints are only accepted when `mentionsTicker()` confirms the text actually mentions the company. One-time cleanups: `scripts/cleanup-mislinks.ts --dry-run`. **`wrong_tickers` never removes `extraction_method='api'` links** (`removeTickersFromNews` filters them): provider/regulator-annotated tickers are higher-confidence truth than the LLM's read of a headline — it was unlinking SEC Form 4s of new spinoffs (HONA ≠ HON, 2026-07-20) and orphaning them from the insider ingest.
- **Live feed window is ROLLING 24h** (`liveFeedWindowStart()`), not calendar "today UTC" — the day-boundary cut emptied the feed at 00:00Z (18:00 for the user, mid after-market) and it refilled drop by drop. `startOfTodayUtc()` survives only for the per-issuer daily Form 4 cap. The client Pusher cutoff in `feed-list.tsx` must stay aligned with the server window.
- **publishedAt is clamped at ingestion** (refresh-news): anything >2min in the future becomes `now` — investing.com emits pubDates ~3h ahead and future dates pin to the top of every `publishedAt DESC` feed.
- **Score 1-5 + sentiment -5..+5.** Don't change the range without bumping `PROMPT_VERSION` in `lib/scoring/prompt.ts`.
- **`NEXT_PUBLIC_PUSHER_*`** are the only client-side Pusher creds; `PUSHER_SECRET` is server-only and never exposed.

## Build & test

```bash
pnpm dev              # local dev server (port 3000)
pnpm build            # production build
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint
pnpm db:generate      # generate migration after schema changes
pnpm db:migrate       # apply migrations to Neon
pnpm cron:local       # run cron pipeline once locally
```

## Local daemon — fast local access with pinned watchlist

The public Worker is anonymous (no `LOCAL_MODE`), so the user's watchlist
won't auto-appear there. For daily personal use the dashboard serves from
`localhost:3030` via a macOS LaunchAgent that runs the prod `next start`
build, auto-restarts on crash, and pins the user's session UUID via env
vars so the watchlist appears without manual cookie injection. The repo
lives at `~/dev/catalyst-local` (moved off `~/Desktop` — iCloud File
Provider broke launchd reads there).

```bash
pnpm daemon:install   # First-time setup: builds, installs plist, starts agent
pnpm daemon:status    # Show plist + agent + port + URL
pnpm daemon:logs      # Tail stdout + stderr
pnpm daemon:restart   # Stop, rebuild if source newer, start
pnpm daemon:stop      # Unload agent + kill any stray listener
```

- Port: `3030` (chosen to coexist with `pnpm dev` on 3000)
- Plist source: `scripts/com.catalyst.local.plist`
- Installed at: `~/Library/LaunchAgents/com.catalyst.local.plist`
- Logs: `.next/daemon-logs/{stdout,stderr}.log`
- RAM: ~130-200MB RSS (bounded by `--max-old-space-size=512` in plist)

**Session pinning**: set `LOCAL_DEFAULT_SESSION_ID=<your-uuid>` in the user
environment or `.env.local`. Combined with `LOCAL_MODE=1` (set by the
plist), `lib/session.ts` falls back to that UUID when no cookie is
present. Never set `LOCAL_MODE=1` on the public Worker (or any shared
host) — would pin all anonymous users to the same watchlist.

**TCC gotcha**: the plist uses `pnpm --dir /abs/path` instead of a shell
wrapper because LaunchAgents cannot `chdir` into TCC-protected dirs on
modern macOS without Full Disk Access for `/bin/bash`. The `--dir` flag
dodges the issue.

### Auto-scorer (second LaunchAgent)

A companion `com.catalyst.scorer` agent runs
`drain-scoring.ts 30` every 15 minutes from your Mac. It complements
the GH Actions cron (which GitHub throttles to 1-4h intervals on public
repos) by firing smaller, faster bursts. With batch scoring v4 each
tick costs ~3 LLM calls for 30 items, so quota is no longer the
bottleneck.

### Refresher (third LaunchAgent, 2026-07-16)

`com.catalyst.refresher` runs `refresh-once.ts` every 10 minutes:
full news fetch + insert + Pusher broadcast from the Mac, covering the
gaps GitHub's throttling leaves (without it the feed advanced in
1-2h bursts). Its plist sets `SKIP_MARKETAUX=1` — Marketaux free tier
is 100 req/day and only flows in via the GH Actions cron. Control:
`pnpm refresher:{install,status,logs,stop,run}`.

### AI Brief

`lib/ai/brief.ts` turns the top-30 scored news of the last 24h
(impact≥3) + the watchlist into a 5-8 bullet desk-style digest
(watchlist bullets starred). Regenerates when the latest is >4h old —
wired into both cron-runner and refresh-once, so real cadence is
~4-6/day. Stored in `ai_briefs` (last 20 kept), rendered by
`components/feed/brief-panel.tsx` (server-side `<details>` strip above
the live feed). Manual run: `pnpm exec tsx scripts/generate-brief.ts`.

```bash
pnpm scorer:install   # First-time: copy plist + load + run immediately
pnpm scorer:status    # Both daemons' state (same as pnpm daemon:status)
pnpm scorer:logs      # Tail scorer stdout + stderr
pnpm scorer:stop      # Unload (kills any in-flight drain)
pnpm scorer:run       # One-shot foreground tick, useful for debugging
```

The scorer plist uses `pnpm exec tsx scripts/drain-scoring.ts` rather
than `pnpm tsx ...` — the latter triggers
`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` because `tsx` isn't in the
package.json scripts. Same TCC workaround as the main daemon.

## OpenRouter key pool

Free-tier scoring uses a pool of OpenRouter API keys to multiply the
`free-models-per-day` cap (1000 calls/day account-wide). When a key
returns a 429 whose body contains `free-models-per-day`, the provider
marks that whole key cooled-down until the next 00:00 UTC and rotates
to the next available key. Per-model RPM/TPM 429s still fall through
the model fallback chain on the same key.

```bash
# .env.local  OR  GitHub Secrets
OPENROUTER_API_KEYS=sk-or-v1-aaa…,sk-or-v1-bbb…,sk-or-v1-ccc…
# Or single-key (back-compat):
OPENROUTER_API_KEY=sk-or-v1-aaa…
```

`getKeyPoolStatus()` in `lib/providers/openrouter.ts` returns the live
pool state (labels + cooldownUntil) without exposing the keys
themselves — wire it into a script or `/api/health` when you want to
see which keys are alive.

**Important**: OpenRouter ToS forbids multiple accounts per person.
Using key rotation across separate accounts carries account-ban risk
(detected via IP, payment fingerprint, or email pattern). This is a
user-accepted tradeoff; never document the multi-account technique
publicly or commit the keys.

## Common gotchas

- **NEVER `export const runtime = "edge"`** in an App Router route. `@opennextjs/cloudflare` does not support the edge runtime: the Worker returns a bare 500 **before entering the handler** — even on paths that would answer 400 without touching the network, which makes it look like a provider outage rather than a config bug. `/api/bars` kept `runtime = "edge"` through the Vercel→Cloudflare migration and the ticker charts were dead in production from 2026-07-15 to 2026-07-21 (a concurrent Yahoo 429 wave masked it: locally the same route degraded to `{"bars":[]}`, the identical symptom). Every route must be `"nodejs"`.
- **DB result shape**: `@neondatabase/serverless` `db.execute(sql\`\`)` returns `{ rows, rowCount }`, NOT an array-like RowList (postgres-js did). Use `unwrapRows()` from `lib/db/index.ts` on raw execute results, and read `rowCount` for affected-row counts. Drizzle query-builders (`db.select()`) still return arrays. Don't reintroduce `postgres-js`.
- **No top-level await in `lib/db`** (or anything imported by tsx scripts) — tsx compiles scripts to CJS and rejects it. The `ws` fallback for Node <22 uses a guarded `require`.
- Drizzle Kit and tsx scripts need explicit `.env.local` loading via `dotenv` config — don't use `dotenv/config` since static imports are hoisted before env loads.
- Yahoo Finance unofficial may break — wrap calls in try/catch and degrade gracefully.
- OpenRouter `:free` models are frequently rate-limited upstream and the catalog changes (owl-alpha was pulled 2026-07 → 404). If a model 404s, check availability at `https://openrouter.ai/api/v1/models` and swap in the fallback chain (`lib/providers/openrouter.ts`). If all fail, news is left unscored (UI shows "—").
