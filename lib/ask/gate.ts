// Puerta común de /api/ask y /api/portfolio-review.
//
// Estaba dentro de la route de /ask; se saca aquí al aparecer el segundo
// endpoint generativo. El cubo del rate limit siendo COMPARTIDO entre los
// dos no es un efecto colateral, es lo que se quiere: un bot que alterne
// entre ambos endpoints no debe tener el doble de presupuesto que uno que
// martillee sólo uno.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, claimableSessionIds } from "@/lib/session";
import { isWorkersRuntime } from "@/lib/articles/enrich";

export { isWorkersRuntime };

// Rate limit en el propio Worker. El sitio vive en *.workers.dev — no hay
// zona propia donde colgar una regla WAF de Cloudflare, así que el freno va
// en código. Estado por isolate en un Map PLANO (el veto de Workers es a
// objetos con I/O compartidos entre requests, no a datos): no es perfecto
// (cada isolate cuenta por su cuenta) pero contra un bot desde pocas IPs
// basta, y una request anónima dispara ~20 queries a Neon — el mismo tipo
// de gasto sin techo que acabó en la suspensión de Vercel.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 8;
const rlHits = new Map<string, { n: number; t: number }>();

// Cubos con nombre. El de por defecto ("spend") es COMPARTIDO a propósito
// entre todo lo generativo: un bot que alterne entre /ask, la revisión y los
// falsadores no debe tener el triple de presupuesto que uno que martillee
// uno solo. Los otros dos existen porque su cliente legítimo tiene un ritmo
// que no cabe en 8/min y meterlos en el cubo común los rompería:
//
//   "prices" → el job de outcomes del Lab (lib/signals/outcomes.ts) recorre
//     hasta DEFAULT_MAX_SYMBOLS=40 símbolos + el benchmark en un bucle
//     secuencial, así que una pasada son ~41 peticiones seguidas desde la
//     MISMA IP de GitHub Actions. Con 8/min se llevaría 429s, y un 429 aquí
//     no es inocuo: `fetchViaProxy` lo convierte en serie vacía y el evento
//     gasta un intento de los 10 que tiene antes de abandonarse.
//   "health" → el workflow catalyst-health sondea cada 2h. Va aparte para
//     que un sondeo de monitorización no consuma el presupuesto de las
//     preguntas del dueño (ni al revés).
export const RL_BUCKETS = {
  spend: RL_MAX,
  prices: 60,
  health: 30,
} as const;

export type RlBucket = keyof typeof RL_BUCKETS;

export function rateLimited(req: Request, bucket: RlBucket = "spend"): boolean {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const h = rlHits.get(key);
  if (!h || now - h.t > RL_WINDOW_MS) {
    // Poda tosca pero suficiente: el Map no puede crecer sin límite en un
    // isolate de larga vida.
    if (rlHits.size > 2000) rlHits.clear();
    rlHits.set(key, { n: 1, t: now });
    return false;
  }
  h.n++;
  return h.n > RL_BUCKETS[bucket];
}

/** ¿Puede esta request gastar cuota de proveedor? Sólo la sesión del
 *  dueño en el Worker público; en local siempre (es su propia máquina). */
export async function llmAllowed(): Promise<boolean> {
  if (!isWorkersRuntime) return true;
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value?.trim().toLowerCase() ?? "";
  return sid !== "" && claimableSessionIds().has(sid);
}

/**
 * La puerta ÚNICA de todo lo que gasta cuota de proveedor.
 *
 * Existe porque el criterio estaba escrito a mano en cada ruta y las tres
 * rutas que se añadieron después (`ticker-brief`, `fundamentals`,
 * `adj-closes`) se lo saltaron enteras: la de ticker-brief generaba prosa
 * LLM a cualquier anónimo y la de fundamentals gastaba 3 llamadas FMP de las
 * 250 diarias por símbolo enumerado. Un patrón que hay que acordarse de
 * copiar acaba no copiándose; una función hay que llamarla.
 *
 * Devuelve la respuesta que la ruta debe retornar tal cual, o `null` para
 * seguir. Dos modos:
 *   - `deny` (por defecto): el anónimo recibe 403 y no se le atiende. Para
 *     rutas cuyo trabajo ENTERO cuesta cuota.
 *   - `degrade`: se devuelve `null` igualmente y la ruta consulta
 *     `llmAllowed()` por su cuenta para servir una versión sin cuota. Es lo
 *     que ya hacen /ask y la revisión de cartera.
 * En los dos casos el rate limit se aplica primero.
 *
 * En el daemon local no hace nada: `isWorkersRuntime` es false, así que ni
 * limita ni deniega. La sesión pineada por LOCAL_MODE tampoco necesita el
 * gate — `llmAllowed()` ya devuelve true fuera del Worker.
 */
export async function guardSpend(
  req: Request,
  opts?: { bucket?: RlBucket; mode?: "deny" | "degrade" },
): Promise<NextResponse | null> {
  if (!isWorkersRuntime) return null;
  // La sesión del DUEÑO no pasa por el cubo. El límite existe contra un bot
  // anónimo, y aplicárselo al dueño tiene un coste real: `/api/article` se
  // dispara al expandir cada tarjeta del feed, así que con 8/min compartidos
  // con /ask, abrir nueve noticias seguidas desde el Worker público se
  // habría comido un 429 en la cara del único usuario autorizado a gastar.
  if (await llmAllowed()) return null;
  if (rateLimited(req, opts?.bucket ?? "spend")) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (opts?.mode === "degrade") return null;
  return NextResponse.json({ error: "llm_not_allowed" }, { status: 403 });
}
