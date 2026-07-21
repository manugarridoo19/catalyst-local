import { Header } from "@/components/header";
import { InsiderDigestPanel } from "@/components/insider/digest-panel";
import { FundHoldingsSection } from "@/components/insider/fund-holdings-section";
import { getFundNewPositions, getFundConviction } from "@/lib/funds/queries";
import type { FundConviction, FundNewPosition } from "@/lib/funds/queries";
import {
  InsiderFlowTables,
  ClusterBuysSection,
  FundStakesSection,
  NotableTradesSection,
} from "@/components/insider/sections";
import {
  getLatestInsiderDigest,
  type InsiderDigestRow,
} from "@/lib/ai/insider-digest";
import {
  getInsiderFlow,
  getClusterBuys,
  getRecentStakes,
  getNotableTrades,
  type InsiderFlowRow,
  type ClusterBuyRow,
  type FundStakeRow,
  type NotableTradeRow,
} from "@/lib/insider/queries";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Insider & Smart Money — sección de primera clase: dónde están poniendo el
// dinero insiders (Form 4 open-market) y fondos (13D/G >5%), agregado de la
// BD estructurada que llena el cron, con la lectura IA arriba. Solo LECTURA
// — el parseo de filings vive en el cron (Node), nunca aquí (Worker-safe).

async function loadData(): Promise<{
  digest: InsiderDigestRow | null;
  flow: InsiderFlowRow[];
  clusters: ClusterBuyRow[];
  stakes: FundStakeRow[];
  trades: NotableTradeRow[];
  newPositions: FundNewPosition[];
  conviction: FundConviction[];
  error?: string;
}> {
  try {
    const [digest, flow, clusters, stakes, trades, newPositions, conviction] =
      await Promise.all([
        getLatestInsiderDigest().catch(() => null),
        getInsiderFlow(),
        getClusterBuys(),
        getRecentStakes(),
        getNotableTrades(),
        getFundNewPositions().catch(() => []),
        getFundConviction().catch(() => []),
      ]);
    return { digest, flow, clusters, stakes, trades, newPositions, conviction };
  } catch (err) {
    return {
      digest: null,
      flow: [],
      clusters: [],
      stakes: [],
      trades: [],
      newPositions: [],
      conviction: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function InsiderPage() {
  const { digest, flow, clusters, stakes, trades, newPositions, conviction, error } =
    await loadData();
  const empty =
    !flow.length && !clusters.length && !stakes.length && !trades.length &&
    !newPositions.length && !conviction.length;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header />
      {error ? (
        <div className="border-b border-rose-500/40 bg-rose-500/10 px-6 py-3 font-mono text-xs text-rose-700 dark:text-rose-200">
          {error}
        </div>
      ) : null}
      <InsiderDigestPanel digest={digest} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-6">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h1 className="eyebrow text-[11px] text-foreground">
                Insider &amp; Smart Money
              </h1>
              <p className="mt-1 max-w-2xl font-editorial text-[12.5px] leading-relaxed text-muted-foreground">
                Open-market insider transactions (SEC Form 4) and new 5%+
                fund stakes (13D activist / 13G passive), parsed from the raw
                filings. Grants, option exercises and tax-withholding sales
                are excluded from the flow numbers.
              </p>
            </div>
          </div>

          {empty ? (
            <div className="rounded-sm border border-border/60 bg-card/40 px-4 py-6 text-center">
              <p className="font-mono text-[12px] text-muted-foreground">
                Collecting SEC filings — structured insider data appears here
                as the cron parses new Form 4 and 13D/G filings.
              </p>
            </div>
          ) : (
            <>
              <InsiderFlowTables flow={flow} />
              <ClusterBuysSection clusters={clusters} />
              <FundStakesSection stakes={stakes} />
              <NotableTradesSection trades={trades} />
              <FundHoldingsSection
                newPositions={newPositions}
                conviction={conviction}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
