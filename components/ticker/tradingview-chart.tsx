"use client";

import { useEffect, useRef, useState } from "react";
import { PriceChart } from "@/components/ticker/price-chart";

// TradingView Advanced Chart widget. Free, no API key, realtime para
// cualquier ticker global. Reemplaza nuestro chart de Yahoo (que
// nos rate-limita desde server-side).
//
// Docs: https://www.tradingview.com/widget/advanced-chart/

const CONFIG = {
  autosize: true,
  // Daily candles. Weekly daba ~26 barras en 6M → cada vela enorme,
  // "hyper-zoomed". Con D vemos ~120 velas en 6M → densidad cómoda.
  interval: "D",
  timezone: "Etc/UTC",
  theme: "dark",
  // Estilo de chart: 1=bars, 2=candles, 3=line, 8=area, 9=mountain.
  // Candles ("1") leen mejor a nivel diario/semanal que la línea.
  style: "1",
  locale: "en",
  backgroundColor: "rgba(13, 17, 23, 0)",
  gridColor: "rgba(255, 255, 255, 0.04)",
  // Toolbar superior con date pickers — el usuario puede saltar a 1d/5d/1m.
  withdateranges: true,
  // Time frames disponibles abajo del chart.
  time_frames: [
    { text: "5y", resolution: "W", description: "5 years" },
    { text: "1y", resolution: "D", description: "1 year", title: "1 year" },
    { text: "6m", resolution: "D", description: "6 months" },
    { text: "3m", resolution: "D", description: "3 months" },
    { text: "1m", resolution: "60", description: "1 month" },
    { text: "5d", resolution: "30", description: "5 days" },
    { text: "1d", resolution: "5", description: "1 day" },
  ],
  // Range inicial: 6 meses de datos. Suele dar un zoom legible para
  // estructurar la lectura de catalysts.
  range: "6M",
  allow_symbol_change: false,
  hide_side_toolbar: true,
  hide_volume: false,
  details: false,
  hotlist: false,
  calendar: false,
  studies: [] as string[],
  support_host: "https://www.tradingview.com",
};

export function TradingViewChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // TradingView deniega el canal de datos ("bad auth token" en bucle, chart
  // negro) cuando el Referer del embed es *.workers.dev — medido 2026-08-06:
  // misma config funciona con Referer localhost y sin Referer (carga
  // directa), falla solo embebida en el Worker. Es bloqueo de dominio en su
  // lado, no configurable desde aquí: en ese host se pinta nuestro chart
  // (lightweight-charts sobre /api/bars, cuyo egress CF sí funciona).
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (window.location.hostname.endsWith(".workers.dev")) {
      // En efecto y no en el estado inicial: depende de `window`, y
      // decidirlo durante el render rompería la hidratación (el server
      // siempre pinta la variante widget).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFallback(true);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    // Limpiar contenido previo (cuando navegas entre tickers).
    while (el.firstChild) el.removeChild(el.firstChild);

    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget h-full w-full";
    el.appendChild(inner);

    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.type = "text/javascript";
    // Usamos textContent (no innerHTML) para evitar XSS — TradingView
    // espera la config como texto en el <script> tag.
    script.textContent = JSON.stringify({ ...CONFIG, symbol });
    el.appendChild(script);
  }, [symbol]);

  if (fallback) {
    return <PriceChart symbol={symbol} initial={[]} initialPeriod="3m" />;
  }

  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container relative h-full min-h-0 w-full"
    />
  );
}
