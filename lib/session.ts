import { cookies } from "next/headers";

const COOKIE = "catalyst_session";

// Local-daemon fallback. When the LaunchAgent serves Catalyst from
// localhost (Vercel-down windows), the user's prod cookie isn't present
// on the localhost domain. To keep their watchlist visible without
// manual cookie injection, set LOCAL_DEFAULT_SESSION_ID + LOCAL_MODE=1
// in the daemon env. Both guards are intentional:
//   - LOCAL_MODE=1 prevents accidental session pinning in prod
//   - The variable is opt-in (empty means: behave normally)
// Never set this on Vercel.
function localFallbackSession(): string | null {
  if (process.env.LOCAL_MODE !== "1") return null;
  const id = process.env.LOCAL_DEFAULT_SESSION_ID?.trim();
  if (!id) return null;
  return id;
}

// Genera/lee un id de sesión local guardado como cookie. v1 es single-user
// pero usamos sesión para preparar futuro multi-user sin migración.
export async function getSessionId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE);
  if (existing?.value) return existing.value;
  const fallback = localFallbackSession();
  if (fallback) return fallback;
  const id = crypto.randomUUID();
  // En Server Components no podemos `set`. La cookie la fijamos desde
  // server actions / route handlers cuando haga falta.
  return id;
}

export async function ensureSessionCookie(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE);
  if (existing?.value) return existing.value;
  const fallback = localFallbackSession();
  const id = fallback ?? crypto.randomUUID();
  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}
