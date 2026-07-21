// Backfill del Signal Lab sobre el archivo acumulado (mayo → hoy).
//
//   pnpm exec tsx scripts/backfill-signals.ts --dry-run
//   pnpm exec tsx scripts/backfill-signals.ts
//   pnpm exec tsx scripts/backfill-signals.ts --no-outcomes
//
// Sin esto, /lab nace vacío y tarda un mes en decir algo. Con esto nace con
// muestra real el día uno.
//
// ⚠️ Honestidad metodológica: esto NO es un backtest. Solo se reconstruyen
// señales cuyo DISPARADOR quedó grabado con su fecha en la BD (una fila de
// ai_picks generada aquel día, un filing con su filed_at, un scoring con su
// scored_at). No se re-evalúa nada con criterios de hoy ni se elige qué
// contar: se registra lo que Catalyst emitió entonces, y el precio decide.
// Para las ventanas rodantes (cluster_buy, insider_net_buy) se simula día a
// día hacia delante, respetando el mismo cooldown que en vivo.
//
// La ventana real de cada kind la limita la retención de su tabla origen:
// analyst_upgrade ~20d (purga de news), insider ~90d, stakes ~180d,
// ai_picks/author desde que existen.

import { config } from "dotenv";
// Solo tipos: se borran en compilación, así que no adelantan la carga de
// lib/db antes de que config() haya puesto DATABASE_URL en el entorno.
import type { SignalCandidate } from "../lib/signals/detect";

config({ path: ".env.local" });

const DRY = process.argv.includes("--dry-run");
const NO_OUTCOMES = process.argv.includes("--no-outcomes");

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db, unwrapRows } = await import("../lib/db");
  const { insertSignalEvent } = await import("../lib/signals/detect");

  const candidates: SignalCandidate[] = [];

  // ── ai_pick: todas las tandas históricas ──────────────────────────────
  const picks = unwrapRows<{ id: number; content: string; generated_at: string | Date }>(
    await db.execute(sql`
      SELECT id, content, generated_at FROM ai_picks ORDER BY generated_at ASC
    `),
  );
  for (const row of picks) {
    try {
      const parsed = JSON.parse(row.content) as Array<{
        symbol?: string;
        thesis?: string;
      }>;
      if (!Array.isArray(parsed)) continue;
      for (const p of parsed) {
        if (!p.symbol) continue;
        candidates.push({
          kind: "ai_pick",
          symbol: p.symbol.toUpperCase(),
          refId: String(row.id),
          detectedAt: new Date(row.generated_at),
          meta: { thesis: p.thesis?.slice(0, 240), backfilled: true },
        });
      }
    } catch {
      /* fila corrupta: se salta */
    }
  }

  // ── author_call ───────────────────────────────────────────────────────
  const briefs = unwrapRows<{ id: number; content: string; generated_at: string | Date }>(
    await db.execute(sql`
      SELECT id, content, generated_at FROM author_briefs ORDER BY generated_at ASC
    `),
  );
  for (const row of briefs) {
    try {
      const parsed = JSON.parse(row.content) as {
        stocks?: Array<{ symbol?: string; authorTake?: string }>;
      };
      for (const s of parsed.stocks ?? []) {
        if (!s.symbol) continue;
        candidates.push({
          kind: "author_call",
          symbol: s.symbol.toUpperCase(),
          refId: String(row.id),
          detectedAt: new Date(row.generated_at),
          meta: { take: s.authorTake?.slice(0, 240), backfilled: true },
        });
      }
    } catch {
      /* idem */
    }
  }

  // ── analyst_upgrade (limitado por la purga de news a 20d) ─────────────
  const upgrades = unwrapRows<{
    news_id: number;
    ticker: string;
    headline: string;
    impact: number;
    sentiment: number;
    scored_at: string | Date;
  }>(
    await db.execute(sql`
      SELECT n.id AS news_id, nt.ticker, n.headline, s.impact, s.sentiment, s.scored_at
      FROM news n
      JOIN news_scores s ON s.news_id = n.id
      JOIN news_tickers nt ON nt.news_id = n.id
      WHERE n.category = 'ANALYST' AND s.impact >= 4 AND s.sentiment >= 2
      ORDER BY s.scored_at ASC
    `),
  );
  for (const r of upgrades) {
    candidates.push({
      kind: "analyst_upgrade",
      symbol: r.ticker.toUpperCase(),
      refId: String(r.news_id),
      detectedAt: new Date(r.scored_at),
      meta: {
        headline: r.headline.slice(0, 200),
        impact: r.impact,
        sentiment: r.sentiment,
        backfilled: true,
      },
    });
  }

  // ── stake_13d ─────────────────────────────────────────────────────────
  const stakes = unwrapRows<{
    symbol: string;
    filing_url: string;
    filer_name: string | null;
    percent_of_class: number | null;
    filed_at: string | Date;
  }>(
    await db.execute(sql`
      SELECT symbol, filing_url, filer_name, percent_of_class, filed_at
      FROM fund_stakes WHERE form_type LIKE 'SC 13D%' ORDER BY filed_at ASC
    `),
  );
  for (const r of stakes) {
    candidates.push({
      kind: "stake_13d",
      symbol: r.symbol.toUpperCase(),
      refId: r.filing_url,
      detectedAt: new Date(r.filed_at),
      meta: {
        filer: r.filer_name,
        percent: r.percent_of_class,
        backfilled: true,
      },
    });
  }

  // ── Ventanas rodantes: simulación día a día ───────────────────────────
  // Para cada día D del archivo se recalcula la ventana de 7d que terminaba
  // ESE día, exactamente como la habría visto el cron entonces. detectedAt =
  // D a las 21:00 UTC (después del cierre ET): los Form 4 se presentan a
  // menudo after-hours, así que suponemos que la señal solo era accionable
  // al cierre siguiente. Es la hipótesis CONSERVADORA — nunca acredita al
  // Lab un precio que no se podría haber conseguido.
  const windows = unwrapRows<{
    symbol: string;
    d: string;
    buyers: number;
    buy_value: number;
    net_value: number;
  }>(
    await db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          (SELECT MIN(filed_at)::date FROM insider_trades),
          now()::date, '1 day')::date AS d
      )
      SELECT t.symbol, to_char(days.d, 'YYYY-MM-DD') AS d,
        COUNT(DISTINCT t.owner_name) FILTER (WHERE t.tx_code = 'P')::int AS buyers,
        COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'P'), 0)::float AS buy_value,
        (COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'P'), 0)
          - COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'S'), 0))::float AS net_value
      FROM days
      JOIN insider_trades t
        ON t.filed_at >= days.d - interval '7 days'
       AND t.filed_at < days.d + interval '1 day'
      WHERE t.tx_code IN ('P', 'S')
      GROUP BY t.symbol, days.d
      HAVING COUNT(DISTINCT t.owner_name) FILTER (WHERE t.tx_code = 'P') >= 2
        OR (COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'P'), 0)
            - COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'S'), 0)) >= 1000000
      ORDER BY days.d ASC
    `),
  );
  for (const r of windows) {
    const detectedAt = new Date(`${r.d}T21:00:00Z`);
    if (detectedAt.getTime() > Date.now()) continue;
    const symbol = r.symbol.toUpperCase();
    if (r.buyers >= 2) {
      candidates.push({
        kind: "cluster_buy",
        symbol,
        refId: `${symbol}:${r.d}`,
        detectedAt,
        meta: { buyers: r.buyers, buyValue: r.buy_value, backfilled: true },
      });
    }
    if (r.net_value >= 1_000_000) {
      candidates.push({
        kind: "insider_net_buy",
        symbol,
        refId: `${symbol}:${r.d}`,
        detectedAt,
        meta: { netValue: r.net_value, backfilled: true },
      });
    }
  }

  // CRÍTICO: orden cronológico global. El cooldown suprime lo que llega
  // dentro de la ventana de un evento ya registrado, así que insertar de
  // nuevo a viejo dejaría el primer evento de cada episodio fuera y movería
  // toda la serie hacia delante en el tiempo.
  candidates.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());

  const byKind: Record<string, number> = {};
  for (const c of candidates) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  console.log(
    `[backfill-signals] ${candidates.length} candidatos:`,
    JSON.stringify(byKind),
  );

  if (DRY) {
    console.log("[backfill-signals] --dry-run: nada escrito");
    return;
  }

  const inserted: Record<string, number> = {};
  let total = 0;
  for (const c of candidates) {
    try {
      // price_at_detection = null a propósito: reconstruir un precio intradía
      // de hace semanas sería inventarlo, y el campo es informativo (los
      // retornos salen de adjclose, no de aquí).
      if (await insertSignalEvent(c, null)) {
        inserted[c.kind] = (inserted[c.kind] ?? 0) + 1;
        total++;
      }
    } catch (err) {
      console.warn(
        `[backfill-signals] ${c.kind}/${c.symbol} falló:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  console.log(
    `[backfill-signals] insertados ${total} eventos:`,
    JSON.stringify(inserted),
  );

  if (NO_OUTCOMES) return;

  // Relleno de outcomes hasta drenar. Mismo job resumable del cron; aquí
  // solo se llama en bucle con presupuesto amplio.
  const { runSignalOutcomesCron } = await import("../lib/signals/outcomes");
  let round = 0;
  let filled = 0;
  for (;;) {
    round++;
    const res = await runSignalOutcomesCron({
      maxSymbols: 15,
      maxEvents: 500,
      budgetMs: 120_000,
    });
    filled += res.outcomesFilled;
    console.log(
      `[backfill-signals] outcomes ronda ${round}: ${res.outcomesFilled} rellenos / ${res.eventsProcessed} eventos / ${res.symbols} símbolos (${(res.durationMs / 1000).toFixed(1)}s)`,
    );
    if (res.eventsProcessed === 0 || round >= 200) break;
  }
  console.log(`[backfill-signals] outcomes totales: ${filled}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[backfill-signals] FATAL:", e);
    process.exit(1);
  });
