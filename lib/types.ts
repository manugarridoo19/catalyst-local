// Shape común que TODOS los providers de noticias devuelven.
// El extractor amplía `tickers` con regex/dict después.
export type NormalizedNewsItem = {
  url: string;
  hash: string;
  headline: string;
  source: string; // ej. "finnhub", "marketaux", "marketwatch"
  publishedAt: Date;
  body?: string;
  imageUrl?: string;
  apiTickers: string[]; // tickers anotados por el proveedor (alta confianza)
};

export type ExtractionMethod = "api" | "regex" | "dict";

export type ExtractedTicker = {
  symbol: string;
  method: ExtractionMethod;
};

export type SentimentScore = {
  impact: number; // 1-5
  sentiment: number; // -5..+5
  rationale?: string;
  model: string;
  promptVersion: string;
};
