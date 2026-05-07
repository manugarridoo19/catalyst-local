// Forma de cada noticia que la UI consume — tanto del SSR inicial como
// del live broadcast por Pusher. Las fechas viajan como ISO string para
// poder pasar de server a client sin perder tipos.
import type { NewsCategory } from "@/lib/categorizer";

export type FeedItem = {
  id: number;
  url: string;
  headline: string;
  body?: string | null;
  source: string;
  publishedAt: string; // ISO
  imageUrl?: string | null;
  category?: NewsCategory | null;
  tickers: string[];
  // Metadata del primer ticker (el "primary") — para mostrar logo+nombre
  // sin tener que hacer N queries en el cliente.
  primarySymbol?: string | null;
  primaryName?: string | null;
  primaryLogo?: string | null;
  impact: number | null;
  sentiment: number | null;
  rationale?: string | null;
};
