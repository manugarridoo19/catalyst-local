import { cookies } from "next/headers";

// Exportado para /api/session/claim (fija la cookie en el Worker público
// desde el launcher del escritorio — misma BD, misma watchlist).
export const SESSION_COOKIE = "catalyst_session";
const COOKIE = SESSION_COOKIE;

// Local-daemon fallback. When the LaunchAgent serves Catalyst from
// localhost (Vercel-down windows), the user's prod cookie isn't present
// on the localhost domain. To keep their watchlist visible without
// manual cookie injection, set LOCAL_DEFAULT_SESSION_ID + LOCAL_MODE=1
// in the daemon env. Both guards are intentional:
//   - LOCAL_MODE=1 prevents accidental session pinning in prod
//   - The variable is opt-in (empty means: behave normally)
// Never set this on Vercel.
const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Fallback off-repo (patrón ~/.catalyst-openrouter-keys): los settings del
// usuario impiden a los agentes tocar .env.local, y el plist instalado se
// re-copia desde el repo (público — un UUID commiteado sería un bearer
// token filtrado). El archivo `~/.catalyst-session-id` (mode 600, línea
// `LOCAL_DEFAULT_SESSION_ID=<uuid>`) es la fuente canónica; el launcher
// del escritorio lo lee también. Require guardado, nunca top-level: esto
// solo corre en Node (LOCAL_MODE nunca está en el Worker).
let cachedFileSid: string | null | undefined;
function readSidFile(): string | null {
  if (cachedFileSid !== undefined) return cachedFileSid;
  cachedFileSid = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { homedir } = require("node:os") as typeof import("node:os");
    const raw = readFileSync(`${homedir()}/.catalyst-session-id`, "utf8");
    const m = raw.match(UUID_RE);
    cachedFileSid = m ? m[1].toLowerCase() : null;
  } catch {
    cachedFileSid = null;
  }
  return cachedFileSid;
}

// UUID de la sesión fijada del usuario (env > archivo off-repo), o null.
// Lo usa también /api/session/claim como allowlist en el daemon.
export function getLocalPinnedSessionId(): string | null {
  const env = process.env.LOCAL_DEFAULT_SESSION_ID?.trim();
  if (env) return env;
  return readSidFile();
}

const UUID_EXACT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sesiones "del dueño": la allowlist de claim (CLAIMABLE_SESSION_IDS,
// secret del Worker) + la sesión fijada local. La usan /api/session/claim
// (anti session-fixation) y /api/article (gate del LLM on-click en el
// Worker público — un anónimo no debe poder drenar la cuota LLM).
export function claimableSessionIds(): Set<string> {
  const raw = [
    process.env.CLAIMABLE_SESSION_IDS ?? "",
    getLocalPinnedSessionId() ?? "",
  ].join(",");
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => UUID_EXACT_RE.test(s)),
  );
}

function localFallbackSession(): string | null {
  if (process.env.LOCAL_MODE !== "1") return null;
  return getLocalPinnedSessionId();
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
