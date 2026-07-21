import { getSignalStats } from "@/lib/signals/queries";
import { KIND_SPECS, MIN_SAMPLE, type SignalKind } from "@/lib/signals/kinds";

// Priors empíricos: el track record del Lab realimentando los prompts.
//
// Ésta es la tesis de la fase 1 hecha código. El Lab no predice nada — mide.
// Y lo que mide se devuelve al generador como CALIBRACIÓN: si los cluster
// buys han batido a SPY en 30d y los upgrades de analista no, el modelo debe
// ser más exigente con los segundos. Se inyecta solo con muestra suficiente
// (n ≥ MIN_SAMPLE): con n=6 estaríamos enseñándole ruido.

const PRIOR_HORIZONS = [7, 30];

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export async function getEmpiricalPriors(
  kinds?: SignalKind[],
): Promise<string | null> {
  let stats;
  try {
    stats = await getSignalStats();
  } catch {
    return null; // los priors son un extra: si fallan, el prompt sale sin ellos
  }
  const wanted = kinds ? new Set<string>(kinds) : null;
  const lines: string[] = [];

  for (const kind of Object.keys(KIND_SPECS) as SignalKind[]) {
    if (wanted && !wanted.has(kind)) continue;
    const parts: string[] = [];
    for (const h of PRIOR_HORIZONS) {
      const s = stats.find((x) => x.kind === kind && x.horizon === h);
      if (!s || s.n < MIN_SAMPLE) continue;
      const excess =
        s.avg_excess != null ? `, ${pct(s.avg_excess)} vs SPY` : "";
      parts.push(
        `${h}d: avg ${pct(s.avg_return)}${excess}, ${s.hit_rate.toFixed(0)}% positive (n=${s.n})`,
      );
    }
    if (parts.length) {
      lines.push(`- ${KIND_SPECS[kind].label} → ${parts.join(" | ")}`);
    }
  }
  if (!lines.length) return null;

  return [
    "",
    "EMPIRICAL PRIORS — how Catalyst's OWN past signals of each type actually performed afterwards (close-to-close on split/dividend-adjusted prices, benchmarked against SPY over the exact same sessions, recorded prospectively):",
    ...lines,
    "Use these ONLY to calibrate how demanding to be: signal types that have not beaten the benchmark deserve stricter selection and a more measured tone. Never quote these aggregate numbers in your output and never present them as a forecast for any individual stock.",
  ].join("\n");
}
