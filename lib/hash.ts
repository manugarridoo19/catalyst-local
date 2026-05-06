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
export function hashUrl(rawUrl: string): string {
  let normalized: string;
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    u.host = u.host.toLowerCase();
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    if (u.pathname.endsWith("/") && u.pathname.length > 1) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    normalized = u.toString().toLowerCase();
  } catch {
    // URL inválida — usar el string crudo como fallback.
    normalized = rawUrl.toLowerCase().trim();
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}
