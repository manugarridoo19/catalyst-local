import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reclama una sesión existente fijando su cookie y redirige a /. Lo usa el
// launcher del escritorio cuando el daemon local no responde: abre el
// Worker público con ?sid=<LOCAL_DEFAULT_SESSION_ID> y la watchlist del
// usuario (misma BD Neon) aparece también en el host público. El UUID
// actúa como bearer token — es unguessable y solo da acceso a la
// watchlist de esa sesión, el mismo poder que ya otorga la cookie.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sid = url.searchParams.get("sid")?.trim() ?? "";
  const res = NextResponse.redirect(new URL("/", url.origin));
  if (UUID_RE.test(sid)) {
    res.cookies.set(SESSION_COOKIE, sid.toLowerCase(), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
