import { createHash } from "node:crypto";

const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
];

// Normaliza la URL (sin tracking, sin hash, lowercase host) y devuelve un
// hash de 32 chars. Sirve para deduplicar la misma noticia llegando por
// fuentes/tracking distintos.
//
// Audit 2026-05-12 #9: lowercase aplica SOLO al host (RFC 3986 §3.2.2 —
// case-insensitive). Path + query se preservan en su capitalización
// original; algunas fuentes (Reuters, ciertos CMS) usan paths con mixed
// case que NO son equivalentes — `/Markets/Article` vs `/markets/article`
// pueden ser distintos recursos en servers case-sensitive.
export function hashUrl(rawUrl: string): string {
  let normalized: string;
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    u.host = u.host.toLowerCase();
    // El protocolo también es case-insensitive; el constructor URL ya lo
    // normaliza a lowercase, pero por defensa lo dejamos explícito.
    u.protocol = u.protocol.toLowerCase();
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    if (u.pathname.endsWith("/") && u.pathname.length > 1) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    normalized = u.toString();
  } catch {
    // URL inválida — usar el string crudo como fallback. Aquí sí hacemos
    // lowercase entero porque sin parseo no podemos separar host de path.
    normalized = rawUrl.toLowerCase().trim();
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}
