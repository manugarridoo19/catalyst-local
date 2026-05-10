"use client";

import { useEffect, useRef } from "react";

// TradingView Advanced Chart widget. Free, no API key, realtime para
// cualquier ticker global. Reemplaza nuestro chart de Yahoo (que
// nos rate-limita desde server-side).
//
// Docs: https://www.tradingview.com/widget/advanced-chart/

const CONFIG = {
  autosize: true,
  // Weekly default da una vista de varios meses sin que esté súper-zoomed.
  interval: "W",
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

  useEffect(() => {
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

  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container relative h-full min-h-0 w-full"
    />
  );
}
