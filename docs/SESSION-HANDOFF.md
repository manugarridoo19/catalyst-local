# Traspaso de sesión — 2026-07-25

Estado al cerrar. Se **sobrescribe** cada sesión: no acumular ficheros por
fecha. El histórico vive en el log de git y en la memoria del agente.

Repo **público**: aquí nunca van keys ni valores de secretos, solo rutas.

---

## ⚠️ LO PRIMERO: hay 4 commits SIN PUSHEAR

```
57ae66a  Vista /portfolio: entrada por importe y rendimiento del día
9157178  Umbrales de concentración, vitest y precalentado de la cosecha
febf29d  Revisión de cartera: eje prospectivo en vez de crónica
266e6aa  Revisión de cartera en /ask: watchlist con posiciones reales
```

**Importa porque el cron de GitHub Actions corre desde el repo pusheado.**
`score-orphans.ts` ahora llama a `prewarmPortfolioBodies()`, así que hasta
que se haga `git push` el runner sigue ejecutando el código viejo y el
precalentado de cuerpos **no ocurre en el cron** (sí en el scorer local,
que corre desde el working dir). El Worker ya está desplegado — el deploy
sale del build local, no de git, así que la web va con el código nuevo.

El resto está cerrado: migración aplicada en Neon, Worker desplegado
(`c1321ef0`), daemon local reiniciado, árbol limpio, 53 tests en verde.

---

## Qué se hizo

Una sola línea de trabajo: **convertir la watchlist en una cartera y hacer
que `/ask` la revise mirando hacia adelante**.

### 1. La watchlist es también la cartera (`266e6aa`)

Migración 0022: `watchlist.shares` y `avg_cost`, ambas NULLABLE, con tres
estados semánticos — `NULL` = solo seguimiento · `0` = cerrada · `>0` =
viva. Se amplió esa tabla en vez de crear `positions` porque ~8 consumidores
ya leen de ella (feed, brief, earnings, universo de tickers) y con dos
tablas cada uno tendría que decidir cuál manda.

`lib/portfolio.ts` es TS puro (sin BD) porque lo comparten el rail —
componente cliente— y el retrieval del servidor. **Es la única fuente de
estas cuentas para las tres superficies** (tabla, rail, prompt de la
revisión): si alguna hiciera las suyas, la pantalla y el modelo acabarían
diciendo pesos distintos del mismo valor.

Decisión que hay que preservar: los pesos excluyen del **denominador** las
posiciones que no se pudieron valorar, en vez de contarlas como 0. Contar
un 429 de Finnhub como valor cero reparte ese peso entre las demás e infla
una concentración que no existe; por eso `unpricedSymbols` está en el tipo
de retorno, para obligar a declarar sobre cuánto se calculó.

### 2. La revisión leía lo obvio — y no era el prompt (`febf29d`)

La v1 respondía "la acción cae un 8%". Dos causas **medidas**, no supuestas:

1. Las citas se ordenaban por `impact DESC`, y el scoring de impacto premia
   por definición lo que YA movió el precio → la cita `[1]` de una posición
   que cae es la caída. Ahora se ordena por **peso de categoría** (`MA` 10 >
   `GUIDANCE` 9 > `REGULATORY` 8 > … > `OTHER` 1), recencia después, e
   impacto como último desempate.
2. **El 97% de las noticias no tenía cuerpo extraído** (META 26 de 785 en
   14d; PLTR 1 de 258), porque `article_extracts` sólo se rellena al hacer
   clic o a `ENRICH_BATCH`=4 por tick. El modelo redactaba desde titulares,
   y un titular es lo obvio. La revisión ahora **paga por extraer** con
   `getArticleDetail(id, {allowLlm:false})` — fetch + caché, cero LLM, 20 s
   de presupuesto de pared. Resultado: 22/28 candidatos con cuerpo.

**Dos llamadas LLM encadenadas, no una.** La primera (`forward-ledger`)
sólo EXTRAE compromisos sin resolver a un esquema donde "la acción cayó" no
cabe en ningún campo; la segunda redacta ya sin los artículos delante. Con
una sola llamada el modelo resume por gradiente natural y ninguna
instrucción del prompt lo evitaba de forma fiable — se intentó primero.

Datos prospectivos que llevaban meses en la BD sin leerse:
`earnings_events.eps_estimate`/`revenue_estimate` (la vara a batir, no el
resultado) y **vendedores sistemáticos** (≥2 ventas del mismo directivo en
90 d + `shares_after` = oferta futura ya conocida; Form 4 no guarda la nota
al pie del 10b5-1, el patrón repetido es su firma observable).

**Ningún número sale del LLM**: beta ponderada y % de cartera que reporta
el mismo día se precalculan en `deriveAggregates` y el prompt prohíbe la
aritmética. En la primera prueba real el modelo los estimaba a ojo y
acertaba por poco — el modo de fallo que nadie audita.

**El gate de evidencia vive en código** (`applyEvidenceGate`), no en el
prompt: una postura sin cita válida ni hecho duro declarado ante la SEC se
degrada a `none` y se marca. La cita además tiene que mencionar ESE
símbolo — sin esa comprobación el modelo colgó de META la cita del Iridium
de RKLB, que existía y por tanto pasaba un filtro de "número válido".

### 3. Umbrales, tests y precalentado (`9157178`)

- `concentrationFlags()`: regla de fondo **no gritar por lo inevitable**.
  Con <5 posiciones la concentración por posición es aritmética, así que se
  avisa del RECUENTO; "las 3 mayores" sólo salta si ninguna disparó warn
  sola; `Unknown` no es sector concentrado sino calidad de dato. Umbrales
  en la constante `CONCENTRATION` — son preferencia, no definición.
- **El repo ya tiene vitest**: `pnpm test`, 53 tests en `tests/`. La config
  pone un `DATABASE_URL` sintético porque `lib/db` lanza al cargarse y la
  cadena de imports lo arrastra; el driver HTTP de Neon no conecta hasta
  ejecutar una query, y ningún test ejecuta ninguna.
- `lib/cron/prewarm-portfolio.ts`: el cron extrae por adelantado los
  cuerpos de las **posiciones vivas** (guard 1 h vía `job_state`, techo 10
  fetches, `PORTFOLIO_PREWARM=0` lo apaga). No sustituye a la cosecha bajo
  demanda, la deja sin trabajo: la primera revisión del día pagaba ~40 s.

### 4. Vista `/portfolio` (`57ae66a`)

Pestaña propia. Tabla ordenable con acciones, precio de entrada, precio
actual, % y **$ de hoy**, invertido, valor, P&L y peso, más totales, alta
de valores y sección aparte de "solo seguimiento".

- **Editor con dos modos**: acciones o **importe invertido**. Se convierte
  al guardar (`sharesFromAmount`) porque el esquema guarda `shares` +
  `avg_cost` como forma canónica — un importe suelto no permite recalcular
  valor ni P&L cuando el precio se mueve.
- `dayChangeAbs` usa el `prevClose` **declarado** por la fuente y sólo lo
  deriva del porcentaje si falta: Finnhub redondea `dp` a 2 decimales y ese
  error se multiplica por el nº de acciones. El total en dinero es suma
  directa (el peso ya está dentro del importe); el porcentual va ponderado.

---

## Estado operativo

- Migración 0022 **aplicada** en Neon.
- Worker desplegado: version `c1321ef0`. Verificado `/`, `/portfolio`,
  `/ask`, `/lab`, `/insider` → 200.
- Daemon local reiniciado con `launchctl kickstart` tras el build (gotcha
  conocido: `cf:build` invalida los chunks del `next start` en marcha).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (53) y `pnpm build` en verde.

## Lo que falta

1. **`git push`** — ver el aviso de arriba. Es lo único que bloquea que el
   precalentado corra en el cron de GitHub.
2. **El usuario no ha registrado posiciones todavía.** Las 7 filas tienen
   `shares` NULL, así que `/portfolio` muestra el estado vacío, la revisión
   responde "aún no has registrado ninguna posición" y el prewarm devuelve
   `skipped: "sin posiciones"`. Todo correcto, pero nada de esto se ejercita
   de verdad hasta que haya una posición viva.
3. **Sin divisa.** El coste medio se guarda en la moneda de cotización. Con
   universo US no hay problema; si entra algo europeo, el total sumaría
   peras con manzanas. Haría falta una columna de divisa y FX antes de
   fiarse del agregado.
4. **Seguimiento multi-turno en `/ask`** ("¿y si quito NVDA?") sigue sin
   hacerse: necesita estado de conversación que hoy no existe en la ruta.
