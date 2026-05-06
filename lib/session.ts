import { cookies } from "next/headers";

const COOKIE = "catalyst_session";

// Genera/lee un id de sesión local guardado como cookie. v1 es single-user
// pero usamos sesión para preparar futuro multi-user sin migración.
export async function getSessionId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE);
  if (existing?.value) return existing.value;
  const id = crypto.randomUUID();
  // En Server Components no podemos `set`. La cookie la fijamos desde
  // server actions / route handlers cuando haga falta.
  return id;
}

export async function ensureSessionCookie(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE);
  if (existing?.value) return existing.value;
  const id = crypto.randomUUID();
  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}
