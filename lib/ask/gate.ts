// Puerta común de /api/ask y /api/portfolio-review.
//
// Estaba dentro de la route de /ask; se saca aquí al aparecer el segundo
// endpoint generativo. El cubo del rate limit siendo COMPARTIDO entre los
// dos no es un efecto colateral, es lo que se quiere: un bot que alterne
// entre ambos endpoints no debe tener el doble de presupuesto que uno que
// martillee sólo uno.

import { cookies } from "next/headers";
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

export function rateLimited(req: Request): boolean {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const h = rlHits.get(ip);
  if (!h || now - h.t > RL_WINDOW_MS) {
    // Poda tosca pero suficiente: el Map no puede crecer sin límite en un
    // isolate de larga vida.
    if (rlHits.size > 2000) rlHits.clear();
    rlHits.set(ip, { n: 1, t: now });
    return false;
  }
  h.n++;
  return h.n > RL_MAX;
}

/** ¿Puede esta request gastar cuota de proveedor? Sólo la sesión del
 *  dueño en el Worker público; en local siempre (es su propia máquina). */
export async function llmAllowed(): Promise<boolean> {
  if (!isWorkersRuntime) return true;
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value?.trim().toLowerCase() ?? "";
  return sid !== "" && claimableSessionIds().has(sid);
}
