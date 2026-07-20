import { sql, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { insiderDigests } from "@/lib/db/schema";
import { proseCompletion } from "@/lib/ai/prose-chain";
import {
  getInsiderFlow,
  getClusterBuys,
  getRecentStakes,
  type InsiderFlowRow,
} from "@/lib/insider/queries";

// Smart Money digest — lectura LLM de los agregados insider+fondos de 7d:
// dónde están comprando los insiders (open market), cluster buys, ventas
// grandes y stakes 13D/G nuevas. El modelo NO ve filings sueltos: ve los
// agregados ya computados por SQL y redacta la lectura. JSON validado por
// código antes de persistir (patrón de lib/ai/picks.ts).
//
// Framing: "as filed with the SEC" — hechos regulatorios, nunca consejo.

const DIGEST_MAX_AGE_HOURS = 6;
const DIGEST_KEEP_LAST = 20;

const DIGEST_SYSTEM_PROMPT = `You are an equities desk analyst reading the week's SEC insider-trading tape (Form 4 open-market buys/sells) and new 5%+ stake filings (13D/13G). You receive pre-computed aggregates. Write the smart-money read of the week.
Output ONLY a JSON object: {"overview": "...", "highlights": [{"symbol": "...", "kind": "cluster_buy"|"net_buy"|"net_sell"|"stake", "note": "..."}]}
Rules:
- "overview": 2-3 sentences on the week's insider/fund posture — where conviction money is flowing, notable one-liners. Grounded ONLY in the provided data; never invent names, amounts or filings.
- "highlights": 3-8 entries, strongest signal first. "note" is 1-2 sentences with the concrete facts: who, direction, ~$ magnitude, % stake if given. Cluster buys (several distinct insiders buying) outrank lone trades; open-market CEO/CFO buys outrank 10%-owner rebalancing; a new 13D (activist intent) outranks a passive 13G.
- Use only symbols present in the data. Skip anything routine or ambiguous — fewer, stronger highlights beat a padded list.`;

export type InsiderHighlight = {
  symbol: string;
  kind: "cluster_buy" | "net_buy" | "net_sell" | "stake";
  note: string;
};

export type InsiderDigestContent = {
  overview: string;
  highlights: InsiderHighlight[];
};

export type InsiderDigestRow = {
  id: number;
  content: InsiderDigestContent;
  model: string;
  tradeCount: number;
  generatedAt: Date;
};

function parseRow(r: {
  id: number;
  content: string;
  model: string;
  tradeCount: number;
  generatedAt: Date;
}): InsiderDigestRow | null {
  try {
    const content = JSON.parse(r.content) as InsiderDigestContent;
    if (typeof content?.overview !== "string" || !Array.isArray(content.highlights)) {
      return null;
    }
    return {
      id: r.id,
      content,
      model: r.model,
      tradeCount: r.tradeCount,
      generatedAt: r.generatedAt,
    };
  } catch {
    console.warn(`[insider-digest] corrupt row id=${r.id} — skipping`);
    return null;
  }
}

export async function getLatestInsiderDigest(): Promise<InsiderDigestRow | null> {
  const rows = await db
    .select()
    .from(insiderDigests)
    .orderBy(desc(insiderDigests.generatedAt))
    .limit(1);
  return rows[0] ? parseRow(rows[0]) : null;
}

const KINDS = new Set(["cluster_buy", "net_buy", "net_sell", "stake"]);

function sanitizeDigest(
  raw: unknown,
  allowed: Set<string>,
): InsiderDigestContent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const overview = String(o.overview ?? "").trim();
  if (overview.length < 30) return null;
  const highlights: InsiderHighlight[] = [];
  if (Array.isArray(o.highlights)) {
    for (const h of o.highlights) {
      if (typeof h !== "object" || h === null) continue;
      const hh = h as Record<string, unknown>;
      const symbol = String(hh.symbol ?? "").toUpperCase().trim();
      const kind = String(hh.kind ?? "").trim();
      const note = String(hh.note ?? "").trim();
      if (!allowed.has(symbol) || !KINDS.has(kind) || note.length < 15) continue;
      highlights.push({
        symbol,
        kind: kind as InsiderHighlight["kind"],
        note: note.slice(0, 320),
      });
      if (highlights.length >= 8) break;
    }
  }
  return { overview: overview.slice(0, 700), highlights };
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function flowLine(r: InsiderFlowRow): string {
  return (
    `${r.symbol}${r.name ? ` (${r.name})` : ""} — net ${fmtUsd(r.net_value)} ` +
    `(bought ${fmtUsd(r.buy_value)} by ${r.buyers}, sold ${fmtUsd(r.sell_value)} by ${r.sellers}, ${r.trades} open-market trades 7d)`
  );
}

// Genera y persiste un digest nuevo. Lanza si no hay datos (tablas recién
// creadas / semana muerta) o si el output del modelo no valida.
export async function generateInsiderDigest(): Promise<InsiderDigestRow> {
  const [flow, clusters, stakes] = await Promise.all([
    getInsiderFlow(7, 20),
    getClusterBuys(7, 8),
    getRecentStakes(12),
  ]);
  const totalInputs = flow.length + stakes.length;
  if (totalInputs < 2) {
    throw new Error(`not enough insider data for digest (${totalInputs} rows)`);
  }

  const buys = flow.filter((r) => r.net_value > 0).slice(0, 10);
  const sells = flow.filter((r) => r.net_value < 0).slice(0, 10);

  const sections: string[] = [];
  if (buys.length) {
    sections.push("NET INSIDER BUYING (7d, open market):", ...buys.map(flowLine));
  }
  if (sells.length) {
    sections.push("", "NET INSIDER SELLING (7d, open market):", ...sells.map(flowLine));
  }
  if (clusters.length) {
    sections.push(
      "",
      "CLUSTER BUYS (≥2 distinct insiders buying, 7d):",
      ...clusters.map(
        (c) =>
          `${c.symbol}${c.name ? ` (${c.name})` : ""} — ${c.buyers} buyers, total ${fmtUsd(c.total_value)}: ${c.owner_names}`,
      ),
    );
  }
  if (stakes.length) {
    sections.push(
      "",
      "NEW 5%+ STAKES (13D activist / 13G passive, most recent):",
      ...stakes.map((s) => {
        const filedDay = new Date(s.filed_at).toISOString().slice(0, 10);
        return `${s.symbol}${s.name ? ` (${s.name})` : ""} — ${s.form_type}${s.filer_name ? ` by ${s.filer_name}` : ""}${s.percent_of_class != null ? `, ${s.percent_of_class}% of class` : ""} (filed ${filedDay})`;
      }),
    );
  }

  const result = await proseCompletion({
    messages: [
      { role: "system", content: DIGEST_SYSTEM_PROMPT },
      { role: "user", content: sections.join("\n") },
    ],
    temperature: 0.3,
    maxTokens: 900,
    jsonMode: true,
    tag: "insider",
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      result.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    );
  } catch {
    throw new Error(
      `insider digest unparseable: "${result.content.slice(0, 120)}"`,
    );
  }
  const allowed = new Set([
    ...flow.map((r) => r.symbol.toUpperCase()),
    ...clusters.map((c) => c.symbol.toUpperCase()),
    ...stakes.map((s) => s.symbol.toUpperCase()),
  ]);
  const content = sanitizeDigest(parsed, allowed);
  if (!content) {
    throw new Error("insider digest output invalid — discarded");
  }

  const inserted = await db
    .insert(insiderDigests)
    .values({
      content: JSON.stringify(content),
      model: result.model,
      tradeCount: totalInputs,
    })
    .returning();

  await db.execute(sql`
    DELETE FROM insider_digests WHERE id NOT IN (
      SELECT id FROM insider_digests ORDER BY generated_at DESC LIMIT ${DIGEST_KEEP_LAST}
    )
  `);

  const r = inserted[0];
  return {
    id: r.id,
    content,
    model: r.model,
    tradeCount: r.tradeCount,
    generatedAt: r.generatedAt,
  };
}

export async function maybeGenerateInsiderDigest(
  maxAgeHours = DIGEST_MAX_AGE_HOURS,
): Promise<{ generated: boolean; digest: InsiderDigestRow | null }> {
  const latest = await getLatestInsiderDigest();
  if (
    latest &&
    Date.now() - latest.generatedAt.getTime() < maxAgeHours * 3600_000
  ) {
    return { generated: false, digest: latest };
  }
  const digest = await generateInsiderDigest();
  return { generated: true, digest };
}
