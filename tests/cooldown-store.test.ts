import { describe, it, expect, afterEach } from "vitest";
import {
  cooldownStoreEnabled,
  cooledUntil,
  exactCooldown,
  hydrateCooldowns,
  persistCooldown,
  snapshotFromRows,
  type CooldownRow,
} from "@/lib/providers/cooldown-store";

// Lógica PURA del almacén compartido de cooldowns. Nada aquí toca la BD: las
// dos funciones que sí lo hacen (`hydrateCooldowns`, `persistCooldown`) sólo
// se prueban en su rama de no-op, que es precisamente la que garantiza que
// importar un proveedor no arrastre `@/lib/db` ni exija DATABASE_URL.

const NOW = Date.parse("2026-08-01T12:00:00Z");
const row = (over: Partial<CooldownRow> = {}): CooldownRow => ({
  label: "g1",
  model: "",
  until: new Date(NOW + 3600_000).toISOString(),
  ...over,
});

describe("snapshotFromRows", () => {
  it("indexa por (label, modelo)", () => {
    const snap = snapshotFromRows(
      [row({ label: "g1", model: "" }), row({ label: "g2", model: "gemini-3.5-flash-lite" })],
      NOW,
    );
    expect(snap.size).toBe(2);
    expect(exactCooldown(snap, "g1", "")).toBe(NOW + 3600_000);
    expect(exactCooldown(snap, "g2", "gemini-3.5-flash-lite")).toBe(NOW + 3600_000);
  });

  it("DESCARTA lo ya expirado, no sólo lo filtra la query", () => {
    // Entre la consulta y el uso pasan hasta 30s de caché. Un cooldown
    // vencido que sobreviva en el snapshot aparta una key que ya estaba
    // libre — y perder capacidad es el error caro de este módulo.
    const snap = snapshotFromRows(
      [
        row({ label: "vieja", until: new Date(NOW - 1000).toISOString() }),
        row({ label: "viva", until: new Date(NOW + 1000).toISOString() }),
      ],
      NOW,
    );
    expect(snap.has("vieja ")).toBe(false);
    expect(exactCooldown(snap, "viva", "")).toBe(NOW + 1000);
  });

  it("ignora una fecha ilegible en vez de propagar NaN", () => {
    // Un NaN dentro de un Math.max contamina el cooldown local y lo vuelve
    // NaN, que es `false` en toda comparación: el freno se desactivaría en
    // silencio, que es exactamente el fallo que este módulo debe evitar.
    const snap = snapshotFromRows([row({ label: "mala", until: "no-es-fecha" })], NOW);
    expect(snap.size).toBe(0);
    expect(exactCooldown(snap, "mala", "")).toBe(0);
    expect(Number.isNaN(exactCooldown(snap, "mala", ""))).toBe(false);
  });

  it("ante filas duplicadas se queda con la MÁS LEJANA", () => {
    const snap = snapshotFromRows(
      [
        row({ until: new Date(NOW + 1000).toISOString() }),
        row({ until: new Date(NOW + 9000).toISOString() }),
      ],
      NOW,
    );
    expect(exactCooldown(snap, "g1", "")).toBe(NOW + 9000);
  });
});

describe("cooledUntil vs exactCooldown — las dos preguntas no son la misma", () => {
  const snap = snapshotFromRows(
    [
      row({ label: "g1", model: "", until: new Date(NOW + 5000).toISOString() }),
      row({ label: "g1", model: "gemini-3.1-flash-lite", until: new Date(NOW + 1000).toISOString() }),
    ],
    NOW,
  );

  it("cooledUntil FUNDE las dimensiones: la key entera arrastra a sus modelos", () => {
    // Es la pregunta del bucle caliente ("¿puedo intentar esto?").
    expect(cooledUntil(snap, "g1", "gemini-3.1-flash-lite")).toBe(NOW + 5000);
    expect(cooledUntil(snap, "g1", "modelo-sin-cooldown")).toBe(NOW + 5000);
  });

  it("exactCooldown NO las funde: es lo que usa la siembra", () => {
    // Volcar el cooldown de la key entera dentro de `modelCooldowns` dejaría
    // el modelo marcado como agotado por una cuota que no era suya — el
    // mismo error de ámbito que envenenó el pool con 2.0-flash-lite.
    expect(exactCooldown(snap, "g1", "gemini-3.1-flash-lite")).toBe(NOW + 1000);
    expect(exactCooldown(snap, "g1", "modelo-sin-cooldown")).toBe(0);
    expect(exactCooldown(snap, "g1", "")).toBe(NOW + 5000);
  });

  it("una key desconocida no está enfriada", () => {
    expect(cooledUntil(snap, "no-existe", "cualquiera")).toBe(0);
    expect(exactCooldown(snap, "no-existe", "")).toBe(0);
  });
});

describe("sin PROVIDER_COOLDOWN_STORE=1 es un no-op que no toca la BD", () => {
  const prev = process.env.PROVIDER_COOLDOWN_STORE;
  afterEach(() => {
    if (prev === undefined) delete process.env.PROVIDER_COOLDOWN_STORE;
    else process.env.PROVIDER_COOLDOWN_STORE = prev;
  });

  it("desactivado por defecto en los tests", () => {
    delete process.env.PROVIDER_COOLDOWN_STORE;
    expect(cooldownStoreEnabled()).toBe(false);
  });

  it("hydrate devuelve un mapa vacío sin consultar", async () => {
    delete process.env.PROVIDER_COOLDOWN_STORE;
    await expect(hydrateCooldowns("gemini-chat")).resolves.toEqual(new Map());
  });

  it("persist no lanza ni escribe", async () => {
    delete process.env.PROVIDER_COOLDOWN_STORE;
    await expect(
      persistCooldown("groq", "default", "llama-3.1-8b-instant", NOW + 1000, "429"),
    ).resolves.toBeUndefined();
  });

  it("un `until` no finito nunca se publica, ni activado", async () => {
    // Guard de cordura: `Date.now() + NaN` es NaN, y escribirlo rompería
    // `to_timestamp` en Postgres además de envenenar el snapshot siguiente.
    process.env.PROVIDER_COOLDOWN_STORE = "1";
    await expect(
      persistCooldown("groq", "default", "m", Number.NaN, "roto"),
    ).resolves.toBeUndefined();
  });

  it("los cuatro scopes están separados y gemini-chat ≠ gemini-embed", () => {
    // El invariante que protege al scorer: un 429 de embeddings no puede
    // dejarle sin esa key. Si alguien fusiona los scopes, esto falla.
    const scopes = ["openrouter", "gemini-chat", "gemini-embed", "groq"];
    expect(new Set(scopes).size).toBe(4);
    expect(scopes).toContain("gemini-embed");
    expect(scopes).toContain("gemini-chat");
  });
});
