import Pusher from "pusher";

let cached: Pusher | null = null;

function getPusher(): Pusher | null {
  if (cached) return cached;
  const { PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER } =
    process.env;
  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) {
    console.warn("[pusher] credenciales no configuradas — broadcast deshabilitado");
    return null;
  }
  cached = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_KEY,
    secret: PUSHER_SECRET,
    cluster: PUSHER_CLUSTER,
    useTLS: true,
  });
  return cached;
}

export const NEWS_CHANNEL = "feed";
export const NEWS_EVENT = "news:new";

export type FeedNewsPayload = {
  id: number;
  headline: string;
  body?: string | null;
  source: string;
  publishedAt: string;
  url: string;
  tickers: string[];
  primarySymbol?: string | null;
  primaryName?: string | null;
  primaryLogo?: string | null;
  // null = aún no scoreada. El cliente lo renderiza como Signif/Sent "—"
  // hasta que score-orphans la puntúe y emita un segundo broadcast con
  // los valores reales que actualiza el card in-place.
  impact: number | null;
  sentiment: number | null;
  rationale?: string | null;
  summary?: string | null;
};

export async function broadcastNews(items: FeedNewsPayload[]): Promise<void> {
  if (!items.length) return;
  const pusher = getPusher();
  if (!pusher) return;
  // Pusher acepta hasta 10 events por trigger batch.
  const chunks: FeedNewsPayload[][] = [];
  for (let i = 0; i < items.length; i += 10) chunks.push(items.slice(i, i + 10));
  for (const chunk of chunks) {
    await pusher.trigger(NEWS_CHANNEL, NEWS_EVENT, { items: chunk });
  }
}
