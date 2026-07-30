import { Header } from "@/components/header";
import { PortfolioTable } from "@/components/portfolio/portfolio-table";
import { getTrades, getWatchlist } from "@/lib/db/queries";
import { getSessionId } from "@/lib/session";
import { getQuotesMap } from "@/lib/providers/finnhub";

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
  const [rows, trades] = await Promise.all([
    getWatchlist(session).catch(() => []),
    getTrades(session).catch(() => []),
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
            }))}
            initialQuotes={quotes}
            initialTrades={trades}
          />
        </div>
      </main>
    </div>
  );
}
