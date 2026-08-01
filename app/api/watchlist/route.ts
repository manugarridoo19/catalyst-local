import { NextResponse } from "next/server";
import {
  addLotToPosition,
  addToWatchlist,
  annotateTrade,
  countWatchlist,
  getJournalCash,
  getTrades,
  getWatchlist,
  reduceLotFromPosition,
  removeFromWatchlist,
  setAxes,
  setPosition,
} from "@/lib/db/queries";
import { ensureSessionCookie } from "@/lib/session";
import { isWorkersRuntime, rateLimited } from "@/lib/ask/gate";
import { HORIZONS } from "@/lib/coach/horizon";
import { CAPITAL, CICLO, MADUREZ } from "@/lib/coach/frames";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const symbolSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z0-9.\-]+$/i, "invalid symbol")
    .transform((s) => s.toUpperCase()),
});

// Topes de cordura, no de negocio: atajan el dedo resbalado (un cero de
// más al teclear) antes de que contamine los pesos de TODA la cartera —
// una posición de 1e12 haría que el resto pesara 0,0% y la revisión
// hablaría de una concentración que no existe.
const MAX_SHARES = 1e9;
const MAX_COST = 1e7;

// `null` = borrar el dato (vuelve a solo seguimiento). `undefined` no se
// acepta: obliga al cliente a ser explícito sobre qué está cambiando.
const positionSchema = symbolSchema.extend({
  shares: z
    .number()
    .finite()
    .min(0)
    .max(MAX_SHARES)
    .nullable(),
  // Coste medio por acción. Se admite posición SIN coste (shares>0,
  // avgCost null): saber cuánto pesa un valor es útil aunque no quieras
  // registrar a cuánto entraste — simplemente esa fila no reporta P&L.
  avgCost: z
    .number()
    .finite()
    .positive()
    .max(MAX_COST)
    .nullable(),
});

// La INTENCIÓN de la operación. El plazo es obligatorio y la tesis no, y
// esa asimetría es deliberada: el plazo lo consume el código para decidir
// si se emite veredicto de precio (sin él, una compra a años recibiría un
// "error" por caer un 4% en tres semanas), mientras que la tesis sólo
// enriquece la prosa. Obligar las dos hundiría la tasa de registro, y una
// operación anotada a medias vale infinitamente más que una sin registrar.
//
// `.max(600)`: es una nota, no un ensayo. El contexto de mercado (qué hacía
// el precio, qué noticias había) NO va aquí — Catalyst ya lo sabe y lo
// adjunta solo. Aquí va sólo lo que nadie más puede saber.
const intentSchema = {
  horizon: z.enum(HORIZONS),
  thesis: z.string().trim().min(1).max(600).nullish(),
};

// Refuerzo: una COMPRA, no un estado. El cliente manda lo que ejecutó
// ("10 acciones a 712,40") y el servidor calcula la posición resultante
// leyendo la actual — si el cliente mandara el total ya recalculado, dos
// pestañas abiertas con una foto vieja se pisarían y la compra de una
// desaparecería sin rastro. `shares` positivo obligatorio: esto sólo suma.
// Reducir es otra operación, con otra aritmética (vender no mueve el coste
// medio) y otro nombre.
const lotSchema = symbolSchema.extend({
  add: z.object({
    shares: z.number().finite().positive().max(MAX_SHARES),
    price: z.number().finite().positive().max(MAX_COST),
    ...intentSchema,
  }),
});

// Recorte. `shares` positivo también: el signo lo lleva el NOMBRE del
// campo, no la cifra. Aceptar negativos en `add` habría dejado dos formas
// de expresar lo mismo y una de ellas se acaba usando por error.
const sellSchema = symbolSchema.extend({
  sell: z.object({
    shares: z.number().finite().positive().max(MAX_SHARES),
    price: z.number().finite().positive().max(MAX_COST),
    ...intentSchema,
  }),
});

// Clasificar una operación YA registrada. Va por el mismo PATCH que las
// demás y se distingue por `annotate`, igual que `add` y `sell` — un verbo
// nuevo por operación multiplicaría rutas que comparten sesión y refresco.
const annotateSchema = z.object({
  annotate: z.object({
    tradeId: z.number().int().positive(),
    horizon: z.enum(HORIZONS),
    thesis: z.string().trim().min(1).max(600).nullish(),
  }),
});

// Declarar qué clase de empresa es una posición, en los TRES ejes. `null`
// la deja sin clasificar, que es un estado legítimo: no saber todavía es
// honesto y el coach lo dice en vez de leerla con un perfil supuesto.
//
// Los tres juntos y ninguno suelto: `parseAxes` exige los tres para leer,
// así que aceptar uno a medias dejaría la posición clasificada a ojos del
// usuario e ilegible para el coach.
const axesSchema = symbolSchema.extend({
  axes: z
    .object({
      madurez: z.enum(MADUREZ),
      capital: z.enum(CAPITAL),
      ciclo: z.enum(CICLO),
    })
    .nullable(),
});

// Tope de símbolos por sesión. No es una regla de producto (una watchlist
// real tiene 5-30 nombres): es que `watchlist` no caduca y el Worker público
// acepta escrituras anónimas, así que sin techo se puede llenar desde fuera
// el mismo depósito de 512 MB en el que la ingesta de embeddings se pausa a
// 380 — y eso pararía la ventana consultable de /ask.
const MAX_WATCHLIST_SYMBOLS = 100;

/** Freno común de las ramas que ESCRIBEN. Las lecturas no pasan por aquí:
 *  el rail de la watchlist refresca cada 60s y castigarlo no protege nada. */
function writeThrottled(req: Request): NextResponse | null {
  if (isWorkersRuntime && rateLimited(req)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  return null;
}

export async function GET() {
  const session = await ensureSessionCookie();
  // `journal` va aparte de `trades`: la lista se corta a 200 para pintar,
  // pero la caja del diario se agrega en el servidor sobre TODAS las filas
  // (getJournalCash) — sumar sobre el corte dejaba fuera lo anterior a la
  // operación 201 sin síntoma.
  const [items, trades, journal] = await Promise.all([
    getWatchlist(session),
    getTrades(session),
    getJournalCash(session),
  ]);
  return NextResponse.json({ items, trades, journal });
}

export async function POST(req: Request) {
  const throttled = writeThrottled(req);
  if (throttled) return throttled;

  const session = await ensureSessionCookie();
  const body = await req.json().catch(() => ({}));
  const parsed = symbolSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_symbol", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if ((await countWatchlist(session)) >= MAX_WATCHLIST_SYMBOLS) {
    return NextResponse.json(
      { error: "watchlist_full", max: MAX_WATCHLIST_SYMBOLS },
      { status: 422 },
    );
  }
  const r = await addToWatchlist(session, parsed.data.symbol);
  if (r === "unknown_symbol") {
    // 422 y no 400: la petición está bien formada, lo que no existe es el
    // valor. El símbolo no entra en `tickers` — ver addToWatchlist.
    return NextResponse.json({ error: "unknown_symbol" }, { status: 422 });
  }
  if (r === "unconfirmed") {
    // No se pudo preguntar al proveedor. 503 porque es transitorio y el
    // cliente debe reintentar, no corregir el símbolo.
    return NextResponse.json({ error: "unconfirmed_symbol" }, { status: 503 });
  }
  const items = await getWatchlist(session);
  return NextResponse.json({ items });
}

// PATCH — fija la posición de un símbolo que YA está en la watchlist.
// 404 si no está: es una señal real (el cliente y el servidor discrepan
// sobre qué hay en la lista), no algo que deba crearse por el camino.
export async function PATCH(req: Request) {
  const throttled = writeThrottled(req);
  if (throttled) return throttled;

  const session = await ensureSessionCookie();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // La rama se elige por la PRESENCIA de la clave, no por si su contenido
  // valida. Con la cascada anterior, un `add` malformado (un `price`
  // negativo, por ejemplo) no casaba con `lotSchema`, seguía cayendo y
  // terminaba en `positionSchema`, así que el cliente recibía
  // `invalid_position` con issues sobre `shares` y `avgCost` — campos que
  // nunca había enviado. Ahora cada verbo falla contando lo suyo.
  const op = (["axes", "annotate", "add", "sell"] as const).find(
    (k) => body !== null && typeof body === "object" && k in body,
  );

  // Los ejes van primero junto a la clasificación: ninguno de los dos toca
  // acciones ni coste, así que no comparten la guarda optimista.
  if (op === "axes") {
    const fr = axesSchema.safeParse(body);
    if (!fr.success) {
      return NextResponse.json(
        { error: "invalid_axes", issues: fr.error.issues },
        { status: 400 },
      );
    }
    const ok = await setAxes(session, fr.data.symbol, fr.data.axes);
    if (!ok) {
      return NextResponse.json({ error: "not_in_watchlist" }, { status: 404 });
    }
    return NextResponse.json({ items: await getWatchlist(session) });
  }

  // Clasificar: no toca la posición, así que no comparte ni el 404 de
  // watchlist ni la guarda optimista de las otras dos ramas.
  if (op === "annotate") {
    const ann = annotateSchema.safeParse(body);
    if (!ann.success) {
      return NextResponse.json(
        { error: "invalid_annotate", issues: ann.error.issues },
        { status: 400 },
      );
    }
    const ok = await annotateTrade(
      session,
      ann.data.annotate.tradeId,
      ann.data.annotate.horizon,
      ann.data.annotate.thesis ?? null,
    );
    if (!ok) {
      // 404 y no 403: desde fuera, una operación de otra sesión y una que no
      // existe son indistinguibles a propósito — confirmar cuál es revelaría
      // que ese id existe en el diario de alguien.
      return NextResponse.json({ error: "trade_not_found" }, { status: 404 });
    }
    return NextResponse.json({ trades: await getTrades(session) });
  }

  // Dos operaciones por el mismo verbo, distinguidas por la presencia de
  // `add`. Comparten el 404 y el refresco de la lista, que es lo único que
  // tenían en común de verdad.
  if (op === "add") {
    const lot = lotSchema.safeParse(body);
    if (!lot.success) {
      return NextResponse.json(
        { error: "invalid_add", issues: lot.error.issues },
        { status: 400 },
      );
    }
    const r = await addLotToPosition(session, lot.data.symbol, {
      ...lot.data.add,
      thesis: lot.data.add.thesis ?? null,
    });
    if (r.status === "not_found") {
      return NextResponse.json({ error: "not_in_watchlist" }, { status: 404 });
    }
    // 409 y no un reintento silencioso: si la fila cambió bajo los pies del
    // cliente, reintentar sobre el estado nuevo podría duplicar una compra
    // que ya entró. Quien decide es el usuario, con la cifra actualizada
    // delante.
    if (r.status === "conflict") {
      const items = await getWatchlist(session);
      return NextResponse.json(
        { error: "stale_position", items },
        { status: 409 },
      );
    }
    const [items, trades, journal] = await Promise.all([
      getWatchlist(session),
      getTrades(session),
      getJournalCash(session),
    ]);
    return NextResponse.json({
      items,
      trades,
      journal,
      position: {
        shares: r.shares,
        avgCost: r.avgCost,
        avgCostUnknown: r.avgCostUnknown,
      },
    });
  }

  if (op === "sell") {
    const sell = sellSchema.safeParse(body);
    if (!sell.success) {
      return NextResponse.json(
        { error: "invalid_sell", issues: sell.error.issues },
        { status: 400 },
      );
    }
    const r = await reduceLotFromPosition(session, sell.data.symbol, {
      ...sell.data.sell,
      thesis: sell.data.sell.thesis ?? null,
    });
    if (r.status === "not_found") {
      return NextResponse.json({ error: "not_in_watchlist" }, { status: 404 });
    }
    if (r.status === "invalid") {
      // 422 y no 400: la petición está bien formada, lo que no cuadra es el
      // ESTADO (vender 10 de una posición de 3). El cliente necesita saber
      // que el problema es el saldo y cuánto hay, para poder corregirlo.
      return NextResponse.json(
        { error: r.reason, shares: r.shares },
        { status: 422 },
      );
    }
    if (r.status === "conflict") {
      const items = await getWatchlist(session);
      return NextResponse.json({ error: "stale_position", items }, { status: 409 });
    }
    const [items, trades, journal] = await Promise.all([
      getWatchlist(session),
      getTrades(session),
      getJournalCash(session),
    ]);
    return NextResponse.json({
      items,
      trades,
      journal,
      position: {
        shares: r.shares,
        avgCost: r.avgCost,
        realized: r.realized,
        closes: r.closes,
      },
    });
  }

  const parsed = positionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_position", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { symbol, shares, avgCost } = parsed.data;
  const ok = await setPosition(session, symbol, shares, avgCost);
  if (!ok) {
    return NextResponse.json({ error: "not_in_watchlist" }, { status: 404 });
  }
  const [items, trades, journal] = await Promise.all([
    getWatchlist(session),
    getTrades(session),
    getJournalCash(session),
  ]);
  return NextResponse.json({ items, trades, journal });
}

export async function DELETE(req: Request) {
  const throttled = writeThrottled(req);
  if (throttled) return throttled;

  const session = await ensureSessionCookie();
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol");
  const parsed = symbolSchema.safeParse({ symbol });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_symbol" }, { status: 400 });
  }
  await removeFromWatchlist(session, parsed.data.symbol);
  const items = await getWatchlist(session);
  return NextResponse.json({ items });
}
