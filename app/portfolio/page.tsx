import { Header } from "@/components/header";
import { PortfolioTable } from "@/components/portfolio/portfolio-table";
import { CoachPanel } from "@/components/portfolio/coach-panel";
import { TrackRecordSection } from "@/components/portfolio/track-record";
import {
  getDeskCalls,
  getLabReference,
  getTrackRecord,
  type DeskCall,
  type LabReference,
} from "@/lib/coach/track-record";
import { getJournalCash, getTrades, getWatchlist } from "@/lib/db/queries";
import { getSessionId } from "@/lib/session";
import { getQuotesMap } from "@/lib/providers/finnhub";
import { parseAxes } from "@/lib/coach/frames";
import { isTradeHorizon } from "@/lib/coach/horizon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Vista de cartera, separada del rail de la watchlist.
//
// El rail es una columna de 288px pensada para vigilar precios de reojo
// mientras se lee el feed: ahí caben símbolo, precio y variación, y poco
// más. Gestionar posiciones (importes, precio de entrada, P&L, contribución
// del día) necesita una tabla con espacio, y sobre todo necesita poder
// COMPARAR filas entre sí — que es justo lo que una columna estrecha
// impide. Por eso es una página y no un panel más.
//
// SSR con quotes iniciales para que la tabla no aparezca vacía y se rellene:
// con posiciones reales delante, un parpadeo de "—" en el P&L se lee como
// un error. El cliente sigue refrescando cada 60s desde ahí.

export default async function PortfolioPage() {
  const session = await getSessionId();
  // `journal` se agrega en el servidor sobre el diario COMPLETO; `trades`
  // es el corte de 200 que se pinta. Con `null` (BD caída) el componente
  // degrada a calcular sobre el corte, que es el comportamiento antiguo.
  const [rows, trades, journal, trackRecord] = await Promise.all([
    getWatchlist(session).catch(() => []),
    getTrades(session).catch(() => []),
    getJournalCash(session).catch(() => null),
    getTrackRecord(session).catch(() => null),
  ]);
  // La referencia del Lab y el cruce con las revisiones solo se pagan
  // cuando hay algo que cruzar: para un visitante anónimo (diario vacío)
  // son cero queries extra.
  const [labRef, deskCalls]: [LabReference, Record<string, DeskCall>] =
    await Promise.all([
      trackRecord?.stats.length
        ? getLabReference().catch(() => ({}))
        : Promise.resolve({}),
      trackRecord?.trades.length
        ? getDeskCalls(
            session,
            trackRecord.trades.map((t) => ({
              date: t.createdAt,
              symbol: t.symbol,
            })),
          ).catch(() => ({}))
        : Promise.resolve({}),
    ]);
  const symbols = rows.map((r) => r.symbol);
  const quotes = symbols.length
    ? await getQuotesMap(symbols).catch(() => ({}))
    : {};

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-6">
          <div>
            <h1 className="eyebrow text-[11px] text-foreground">Portfolio</h1>
            <p className="mt-1 max-w-3xl font-editorial text-[12.5px] leading-relaxed text-muted-foreground">
              Tus posiciones reales, con lo que llevas hoy en dinero y desde
              tu entrada. Puedes registrar cada posición por número de
              acciones o directamente por el importe que metiste — de ahí
              salen el peso en la cartera y el P&amp;L. Lo que registres aquí
              es lo que lee la revisión de cartera en{" "}
              <span className="font-mono text-[11.5px]">/ask</span>.
            </p>
          </div>

          <PortfolioTable
            initialItems={rows.map((r) => ({
              symbol: r.symbol,
              name: r.name,
              sector: r.sector,
              logoUrl: null,
              shares: r.shares,
              avgCost: r.avgCost,
              // Los ejes vienen de BD sin validar: son columnas `text` y un
              // valor viejo o a medias no debe romper la página. `parseAxes`
              // exige los TRES y degrada a `null`, que la UI ya sabe pintar
              // como "sin clasificar".
              axes: parseAxes({
                madurez: r.frameMadurez,
                capital: r.frameCapital,
                ciclo: r.frameCiclo,
              }),
              thesis: r.thesis,
              // Mismo criterio que los ejes: es una columna `text` sin
              // validar y un plazo viejo no debe romper la página.
              thesisHorizon: isTradeHorizon(r.thesisHorizon)
                ? r.thesisHorizon
                : null,
            }))}
            initialQuotes={quotes}
            initialTrades={trades}
            initialJournal={journal}
          />

          {trackRecord ? (
            <TrackRecordSection
              record={trackRecord}
              labRef={labRef}
              deskCalls={deskCalls}
            />
          ) : null}

          <section>
            <h2 className="eyebrow mb-1 text-[10px] text-foreground">Coach</h2>
            <p className="mb-2 max-w-[78ch] font-editorial text-[12.5px] leading-relaxed text-muted-foreground">
              Lo que escribiste al operar, frente a lo que se ha movido y a
              qué lo atribuye la propia empresa. No emite veredictos: un
              margen que se estrecha porque la compañía está comprando
              futuro y otro que se estrecha porque el negocio pierde fuelle
              son el mismo número y la noticia contraria — quien decide eso
              eres tú. Lo que hace el coach es que no se te pase la
              diferencia, y que tu tesis no se pueda reescribir después.
            </p>
            <CoachPanel />
          </section>
        </div>
      </main>
    </div>
  );
}
