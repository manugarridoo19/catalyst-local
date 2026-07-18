import { NextResponse } from "next/server";
import { SESSION_COOKIE, claimableSessionIds } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reclama una sesión fijando su cookie y redirige a /. Lo usa el launcher
// del escritorio cuando el daemon local no responde: abre el Worker
// público con ?sid=<LOCAL_DEFAULT_SESSION_ID> y la watchlist del usuario
// (misma BD Neon) aparece también en el host público.
//
// ANTI session-fixation (flag de la security review): solo se pueden
// reclamar sesiones de la ALLOWLIST (claimableSessionIds en lib/session —
// CLAIMABLE_SESSION_IDS secret del Worker; en el daemon vale
// LOCAL_DEFAULT_SESSION_ID). Sin allowlist el endpoint es un no-op — así
// un link malicioso ?sid=<uuid-del-atacante> no puede fijarle a nadie una
// sesión que el atacante controle. Reclamar tu propio UUID vía CSRF es
// inocuo (te deja como ya estás).

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sid = url.searchParams.get("sid")?.trim() ?? "";
  const res = NextResponse.redirect(new URL("/", url.origin));
  if (UUID_RE.test(sid) && claimableSessionIds().has(sid.toLowerCase())) {
    res.cookies.set(SESSION_COOKIE, sid.toLowerCase(), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
