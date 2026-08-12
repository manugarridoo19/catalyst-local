// Reconstruye el PROMPT REAL de /ask para una pregunta, sin redactar nada.
//
// Existe porque la queja "responde genérico" sólo se diagnostica mirando lo
// que el modelo recibe, y hasta ahora eso había que reconstruirlo a mano —
// que es exactamente donde una reconstrucción puede mentir. Llama al mismo
// `buildAskUserBlock` que la ruta, así que lo que imprime es el mensaje que
// se manda, no una aproximación.
//
// Gasta 1 embedding de la pregunta (igual que una pregunta real del dueño) y
// CERO llamadas de prosa: se para justo antes de redactar. Con --no-embed no
// gasta nada y mide el camino degradado (anónimo / cuota agotada), que es el
// que sirve el Worker público.
//
//   pnpm exec tsx scripts/probe-ask.ts "¿cómo se espera que sea el earnings de $NU?"
//   pnpm exec tsx scripts/probe-ask.ts --no-embed --no-harvest "..."
//   pnpm exec tsx scripts/probe-ask.ts --stats "..."     (sólo el resumen)
//   pnpm exec tsx scripts/probe-ask.ts --outline "..."   (+1 llamada: el guion)

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

type Args = {
  question: string;
  embed: boolean;
  harvest: boolean;
  statsOnly: boolean;
  answer: boolean;
  outline: boolean;
};

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const rest = argv.filter((a) => !a.startsWith("--"));
  return {
    question: rest.join(" ").trim(),
    embed: !flags.has("--no-embed"),
    harvest: !flags.has("--no-harvest"),
    statsOnly: flags.has("--stats"),
    answer: flags.has("--answer"),
    outline: flags.has("--outline"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    console.error('Uso: pnpm exec tsx scripts/probe-ask.ts "tu pregunta"');
    process.exit(2);
  }

  const { classifyJob, classifyScope, classifyFocus } = await import("../lib/ask/intent");
  const { retrieve, extractQuestionSymbols } = await import("../lib/ask/retrieve");
  const { buildAskUserBlock, hasCoverage } = await import("../lib/ai/ask");
  const { buildDecisionFacts } = await import("../lib/ask/decision");
  const { getWatchlist } = await import("../lib/db/queries");
  const { getQuotesMap } = await import("../lib/providers/finnhub");
  const { buildPortfolio, dayAttribution, MARKET_REF_SYMBOLS } = await import(
    "../lib/portfolio"
  );
  const { parseAxes } = await import("../lib/coach/frames");
  const { claimableSessionIds } = await import("../lib/session");

  const job = classifyJob(args.question);
  const focus = classifyFocus(args.question);
  // Mismo orden que la ruta: extraer una vez, clasificar el alcance con el
  // resultado. Si el probe lo hiciera distinto mediría otra cosa, que es
  // exactamente el fallo que esta herramienta existe para no cometer.
  const named = await extractQuestionSymbols(args.question);
  let scope = classifyScope(args.question, named.length > 0);

  let queryVec: number[] | null = null;
  if (args.embed) {
    try {
      const { embedBatch } = await import("../lib/providers/gemini-embed");
      [queryVec] = await embedBatch([args.question], { taskType: "RETRIEVAL_QUERY" });
    } catch (err) {
      console.warn(
        "[probe] embed falló, sigo sin vectorial:",
        err instanceof Error ? err.message.slice(0, 120) : err,
      );
    }
  }

  // La cartera se carga en decisiones Y con alcance de cartera, igual que la
  // ruta. En un script no hay cookie, así que se usa la sesión fijada.
  let portfolio = null;
  let frames = new Map();
  let quotes: Record<string, unknown> = {};
  if (job === "decision" || scope === "portfolio") {
    const [session] = [...claimableSessionIds()];
    if (session) {
      const rows = await getWatchlist(session);
      frames = new Map(
        rows.map((x) => [
          x.symbol,
          parseAxes({ madurez: x.frameMadurez, capital: x.frameCapital, ciclo: x.frameCiclo }),
        ]),
      );
      const live = rows.filter((x) => x.shares !== null && x.shares > 0);
      quotes = live.length
        ? await getQuotesMap([
            ...live.map((x) => x.symbol),
            ...MARKET_REF_SYMBOLS,
          ]).catch(() => ({}))
        : {};
      portfolio = live.length
        ? buildPortfolio(
            rows.map((x) => ({
              symbol: x.symbol,
              name: x.name,
              sector: x.sector,
              shares: x.shares,
              avgCost: x.avgCost,
            })),
            quotes,
          )
        : null;
    }
  }

  let forceSymbols = named;
  let attribution;
  if (scope === "portfolio") {
    const held = portfolio?.positions.map((p) => p.symbol) ?? [];
    if (held.length) {
      forceSymbols = held;
      attribution = dayAttribution(portfolio!, quotes as never);
    } else {
      scope = "thematic";
    }
  }

  const t0 = Date.now();
  const r = await retrieve({
    question: args.question,
    queryVec,
    harvest: args.harvest,
    job,
    scope,
    forceSymbols,
  });
  const ms = Date.now() - t0;

  let decision;
  if (job === "decision") {
    {
      decision = buildDecisionFacts({
        symbols: r.symbols,
        portfolio,
        facts: r.facts,
        bars: r.forward.bars,
        sellers: r.forward.sellers,
        deals: r.forward.deals,
        risk: r.forward.risk,
        fundChanges: r.forward.fundChanges,
        earnings: r.earnings,
        frames,
      });
    }
  }

  const { shape, system, userBlock } = await buildAskUserBlock(r, args.question, {
    decision,
    focus,
    attribution,
  });

  // Composición de las citas: cuántas hablan del símbolo preguntado y
  // cuántas no. Ésa es la métrica que abrió el diagnóstico del 2026-08-07 —
  // 10 de 20 citas de una pregunta sobre NU eran de NuScale, Novartis,
  // Novo Nordisk, Northrop y Nucor.
  const asked = new Set(r.symbols);
  const own = r.citations.filter((c) => c.symbols.some((s) => asked.has(s)));
  const alien = r.citations.filter((c) => !c.symbols.some((s) => asked.has(s)));
  const byVia = r.citations.reduce<Record<string, number>>((acc, c) => {
    acc[c.via] = (acc[c.via] ?? 0) + 1;
    return acc;
  }, {});
  const chars = (cs: typeof r.citations) =>
    cs.reduce((n, c) => n + c.headline.length + (c.summary?.length ?? 0) + (c.body?.length ?? 0), 0);

  console.log("═".repeat(72));
  console.log(`PREGUNTA  ${args.question}`);
  console.log(
    `JOB ${job} · SCOPE ${scope} · FOCUS ${focus} · SHAPE ${shape} · cobertura ${hasCoverage(r) ? "sí" : "NO"} · ${ms}ms`,
  );
  console.log(`SÍMBOLOS  ${r.symbols.join(", ") || "(ninguno)"}`);
  console.log(
    `CITAS     ${r.citations.length} — ` +
      Object.entries(byVia)
        .map(([k, v]) => `${k}:${v}`)
        .join(" · "),
  );
  console.log(
    `           del símbolo: ${own.length} (${chars(own).toLocaleString("es-ES")} chars) · ` +
      `AJENAS: ${alien.length} (${chars(alien).toLocaleString("es-ES")} chars)`,
  );
  if (alien.length) {
    for (const c of alien) {
      console.log(`             ✗ [${c.n}] [${c.symbols.join(",")}] ${c.headline.slice(0, 66)}`);
    }
  }
  console.log(
    `CUERPOS   ${r.bodiesAvailable} con cuerpo · cosecha ${r.harvested}/${r.attempted} · comunicados ${r.earnings.length}`,
  );
  if (attribution) {
    console.log(
      `ARRASTRE  ${attribution.contributions.length} posiciones medidas` +
        (attribution.unmeasured.length
          ? ` · sin precio hoy: ${attribution.unmeasured.join(", ")}`
          : ""),
    );
    for (const c of attribution.contributions) {
      console.log(
        `             ${c.symbol.padEnd(6)} ${c.dayChangePct >= 0 ? "+" : ""}${c.dayChangePct.toFixed(2)}%` +
          ` · peso ${c.weightPct.toFixed(1)}%` +
          ` · ${c.contribPct >= 0 ? "+" : ""}${c.contribPct.toFixed(2)} pts`,
      );
    }
  }
  console.log(
    `PROMPT    system ${system.length.toLocaleString("es-ES")} chars · user ${userBlock.length.toLocaleString("es-ES")} chars`,
  );
  if (decision) {
    console.log(
      `DECISIÓN  presiones ${decision.pressures.length} · fechados ${decision.dated.length}`,
    );
  }
  console.log("═".repeat(72));

  // --outline gasta UNA llamada barata: el guion. Es lo que hay que mirar
  // cuando la queja es "las secciones no tienen que ver con lo que pregunté".
  if (args.outline) {
    const { planOutline } = await import("../lib/ai/ask-outline");
    const { outlineInventoryFor } = await import("../lib/ai/ask");
    const outline = await planOutline(outlineInventoryFor(r, args.question, attribution));
    console.log("\n──────── GUION ────────\n");
    if (!outline) console.log("(sin guion — se usaría la plantilla fija)");
    else for (const sec of outline) console.log(`  ${sec.key.padEnd(16)} ${sec.title}\n${" ".repeat(20)}${sec.brief}`);
    console.log();
  }

  if (!args.statsOnly) {
    console.log("\n──────── MENSAJE DE USUARIO (literal) ────────\n");
    console.log(userBlock);
  }

  // --answer SÍ gasta prosa (1 llamada, 2 si el JSON viene roto). Es la única
  // forma de ver lo que el usuario lee, y por eso está detrás de un flag: el
  // uso normal del probe es mirar el material, que no cuesta cuota.
  if (args.answer) {
    const { askArchive } = await import("../lib/ai/ask");
    console.log("\n──────── RESPUESTA ────────\n");
    const a = await askArchive(r, args.question, { decision, focus, attribution });
    console.log(`modelo: ${a.model} · cobertura: ${a.coverage} · citas usadas: ${a.citations.length}`);
    for (const s of a.sections) {
      console.log(`\n${s.title ?? "—"}\n${s.text}`);
    }
    if (a.citations.length) {
      console.log("\nFuentes:");
      for (const c of a.citations) console.log(`  [${c.n}] ${c.headline.slice(0, 80)}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
