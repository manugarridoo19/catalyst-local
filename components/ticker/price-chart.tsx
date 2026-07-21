"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  AreaSeries,
} from "lightweight-charts";
import { cn } from "@/lib/utils";

export type Bar = {
  time: number; // unix seconds
  close: number;
};

const PERIODS = ["1d", "1w", "1m", "3m", "1y"] as const;
type Period = (typeof PERIODS)[number];

const POLL_MS: Record<Period, number | null> = {
  "1d": 30_000,
  "1w": 60_000,
  "1m": 5 * 60_000,
  "3m": null,
  "1y": null,
};

export function PriceChart({
  symbol,
  initial,
  initialPeriod = "1d",
}: {
  symbol: string;
  initial: Bar[];
  initialPeriod?: Period;
}) {
  const [period, setPeriod] = useState<Period>(initialPeriod);
  const [bars, setBars] = useState<Bar[]>(initial);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  const change = useMemo(() => {
    if (bars.length < 2) return null;
    const first = bars[0].close;
    const last = bars[bars.length - 1].close;
    return { abs: last - first, pct: ((last - first) / first) * 100, last };
  }, [bars]);

  const isUp = (change?.abs ?? 0) >= 0;

  // Construir/actualizar el chart cuando cambie el periodo o lleguen datos.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (!chartRef.current) {
      const chart = createChart(el, {
        autoSize: true,
        layout: {
          background: { color: "transparent" },
          textColor: "rgb(161 161 170)",
          fontFamily: "var(--font-geist-mono), monospace",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.03)" },
          horzLines: { color: "rgba(255,255,255,0.03)" },
        },
        timeScale: { borderVisible: false, timeVisible: period === "1d" || period === "1w" },
        rightPriceScale: { borderVisible: false },
        crosshair: { mode: 0 },
      });
      chartRef.current = chart;
    }

    const chart = chartRef.current;
    if (!chart) return;

    const lineColor = isUp ? "rgb(74 222 128)" : "rgb(244 63 94)";
    const topColor = isUp ? "rgba(74,222,128,0.25)" : "rgba(244,63,94,0.25)";
    const bottomColor = isUp ? "rgba(74,222,128,0)" : "rgba(244,63,94,0)";

    if (!seriesRef.current) {
      seriesRef.current = chart.addSeries(AreaSeries, {
        lineColor,
        topColor,
        bottomColor,
        lineWidth: 2,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      });
    } else {
      seriesRef.current.applyOptions({ lineColor, topColor, bottomColor });
    }

    chart.timeScale().applyOptions({
      timeVisible: period === "1d" || period === "1w",
    });

    seriesRef.current.setData(
      bars.map((b) => ({ time: b.time as never, value: b.close })),
    );
    chart.timeScale().fitContent();
  }, [bars, period, isUp]);

  // Cleanup al desmontar.
  useEffect(() => {
    return () => {
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Cambiar periodo → fetch nuevo set de bars.
  useEffect(() => {
    let cancelled = false;
    if (period === initialPeriod && bars === initial) return;
    fetch(`/api/bars?symbol=${symbol}&period=${period}`)
      // Si la respuesta no es OK, vaciamos: dejar las barras del periodo
      // ANTERIOR bajo la etiqueta del nuevo es mentir con un gráfico. El
      // estado vacío ("No data for X · Y") ya dice la verdad.
      .then((r) => (r.ok ? r.json() : { bars: [] }))
      .then((d: { bars: Bar[] }) => {
        if (!cancelled) setBars(d.bars ?? []);
      })
      .catch(() => {
        if (!cancelled) setBars([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, symbol]);

  // Polling para realtime feel.
  useEffect(() => {
    const interval = POLL_MS[period];
    if (!interval) return;
    const id = setInterval(() => {
      fetch(`/api/bars?symbol=${symbol}&period=${period}`)
        .then((r) => r.json())
        .then((d: { bars: Bar[] }) => {
          if (d.bars && d.bars.length) setBars(d.bars);
        })
        .catch(() => {});
    }, interval);
    return () => clearInterval(id);
  }, [period, symbol]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <div className="flex items-baseline gap-3">
          {change && (
            <>
              <span className="tick font-mono text-2xl font-bold tabular-nums">
                ${change.last.toFixed(2)}
              </span>
              <span
                className={cn(
                  "tick font-mono text-xs font-semibold tabular-nums",
                  isUp ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400",
                )}
              >
                {isUp ? "+" : ""}
                {change.abs.toFixed(2)} ({isUp ? "+" : ""}
                {change.pct.toFixed(2)}%)
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 font-mono text-[10px]">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                "rounded-sm border px-2 py-0.5 uppercase tracking-[0.18em] transition-all",
                period === p
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
      {bars.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          No data for {symbol} · {period}
        </div>
      )}
    </div>
  );
}
