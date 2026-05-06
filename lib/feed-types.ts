// Forma de cada noticia que la UI consume — tanto del SSR inicial como
// del live broadcast por Pusher. Las fechas viajan como ISO string para
// poder pasar de server a client sin perder tipos.
export type FeedItem = {
  id: number;
  url: string;
  headline: string;
  source: string;
  publishedAt: string; // ISO
  imageUrl?: string | null;
  tickers: string[];
  impact: number | null;
  sentiment: number | null;
  rationale?: string | null;
};
