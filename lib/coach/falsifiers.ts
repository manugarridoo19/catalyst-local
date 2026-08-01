import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { checkFalsifiers } from "@/lib/ai/falsifiers";

// Lectura y escritura de falsadores, más el job que los comprueba.
//
// EL JOB CORRE EN EL CRON, no en la ruta del panel. `/api/coach` no llama a
// ningún proveedor y esa propiedad vale la pena conservarla: el contraste
// tiene que seguir viéndose con la cuota agotada. Como los comunicados son
// trimestrales, comprobar en el cron no retrasa nada — y `checked_accession`
// hace que cada filing se pague UNA vez por símbolo, no una por visita.

export type Falsifier = {
  id: number;
  symbol: string;
  text: string;
  source: "propuesto" | "escrito";
  status: "pendiente" | "aprobado" | "rechazado";
  trippedAt: string | null;
  trippedEvidence: string | null;
  createdAt: string;
};

export async function getFalsifiers(session: string): Promise<Falsifier[]> {
  return unwrapRows<Falsifier>(
    await db.execute(sql`
      SELECT id, symbol, text, source, status,
             to_char(tripped_at at time zone 'UTC','YYYY-MM-DD') AS "trippedAt",
             tripped_evidence AS "trippedEvidence",
             to_char(created_at at time zone 'UTC','YYYY-MM-DD') AS "createdAt"
        FROM thesis_falsifiers
       WHERE user_session = ${session}
         AND status <> 'rechazado'
       ORDER BY symbol, id
    `),
  );
}

/** Guarda candidatos como 'pendiente'. Nunca 'aprobado': un falsador que el
 *  modelo redactó y nadie leyó no puede disparar un veredicto en nombre del
 *  usuario. */
export async function saveProposals(
  session: string,
  symbol: string,
  texts: string[],
): Promise<number> {
  if (!texts.length) return 0;
  // Se borran los pendientes anteriores de ese símbolo: proponer otra vez
  // es pedir candidatos NUEVOS, y acumularlos convertiría el panel en una
  // bandeja de entrada. Los aprobados y rechazados no se tocan — son
  // decisiones tomadas.
  await db.execute(sql`
    DELETE FROM thesis_falsifiers
     WHERE user_session = ${session} AND symbol = ${symbol}
       AND status = 'pendiente'
  `);
  for (const t of texts) {
    await db.execute(sql`
      INSERT INTO thesis_falsifiers (user_session, symbol, text, source, status)
      VALUES (${session}, ${symbol}, ${t}, ${"propuesto"}, ${"pendiente"})
    `);
  }
  return texts.length;
}

export async function decideFalsifier(
  session: string,
  id: number,
  status: "aprobado" | "rechazado",
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE thesis_falsifiers
       SET status = ${status}, decided_at = now()
     WHERE id = ${id} AND user_session = ${session}
  `);
  return (res as { rowCount?: number }).rowCount === 1;
}

export async function addWrittenFalsifier(
  session: string,
  symbol: string,
  text: string,
): Promise<void> {
  // Lo escrito por el usuario entra ya aprobado: escribirlo ES aprobarlo.
  await db.execute(sql`
    INSERT INTO thesis_falsifiers
      (user_session, symbol, text, source, status, decided_at)
    VALUES (${session}, ${symbol}, ${text}, ${"escrito"}, ${"aprobado"}, now())
  `);
}

// ─── El job ──────────────────────────────────────────────────────────────

/**
 * Un JSON corrupto en UNA fila no puede tumbar el job entero.
 *
 * Sin esta guarda, un `summary` o un `attribution` mal formado lanzaba
 * dentro del bucle de agrupación —antes de cualquier try/catch— y se
 * llevaba por delante la comprobación de TODOS los símbolos y de todas las
 * sesiones. Y lo peor: el cron lo registra como un aviso más, así que los
 * falsadores dejarían de comprobarse en silencio. `lib/coach/build.ts` ya
 * trataba este caso; aquí faltaba.
 */
function jsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

type Pending = {
  symbol: string;
  accession: string;
  document: string;
  ids: number[];
  texts: string[];
};

/**
 * Comprueba los falsadores APROBADOS que aún no se han evaluado contra el
 * último comunicado de su símbolo.
 *
 * Node-only (llama al LLM). Una llamada por símbolo con falsadores
 * pendientes, no una por falsador: van todos en el mismo prompt porque
 * comparten documento, y trocearlos multiplicaría la cuota sin mejorar nada.
 */
export async function runFalsifierChecks(opts?: {
  maxSymbols?: number;
}): Promise<{ symbols: number; tripped: number; checked: number }> {
  const maxSymbols = opts?.maxSymbols ?? 4;

  const rows = unwrapRows<{
    user_session: string;
    symbol: string;
    id: number;
    text: string;
    accession: string;
    summary: string;
    attribution: string | null;
    headline: string | null;
  }>(
    await db.execute(sql`
      WITH ultimo AS (
        SELECT DISTINCT ON (symbol) symbol, accession, summary, attribution, headline
          FROM earnings_reports
         ORDER BY symbol, filing_date DESC
      )
      SELECT f.user_session, f.symbol, f.id, f.text,
             u.accession, u.summary, u.attribution, u.headline
        FROM thesis_falsifiers f
        JOIN ultimo u ON u.symbol = f.symbol
       WHERE f.status = 'aprobado'
         AND f.tripped_at IS NULL
         AND (f.checked_accession IS NULL OR f.checked_accession <> u.accession)
         -- Sólo símbolos que el usuario SIGUE teniendo en la lista.
         -- thesis_falsifiers no tiene FK contra watchlist (los falsadores
         -- son un criterio escrito y no se borran solos), así que sin esto se
         -- pagaba una llamada LLM por cada comunicado nuevo de una empresa
         -- que ya se vendió y se quitó de la lista — y el resultado no se
         -- pintaba en ninguna parte, porque /api/coach sólo lee posiciones
         -- con shares > 0.
         AND EXISTS (
           SELECT 1 FROM watchlist w
            WHERE w.user_session = f.user_session AND w.symbol = f.symbol
         )
       ORDER BY f.symbol, f.id
    `),
  );
  if (!rows.length) return { symbols: 0, tripped: 0, checked: 0 };

  // Agrupado por (sesión, símbolo): una llamada sirve a todos sus falsadores.
  const groups = new Map<string, Pending & { session: string }>();
  for (const r of rows) {
    const key = `${r.user_session}::${r.symbol}`;
    const g = groups.get(key);
    // El documento que se manda es el resumen + la atribución ya extraída,
    // no el exhibit crudo: volver a bajarlo de SEC costaría una petición por
    // símbolo y el resumen ya lleva las cifras de cabecera con sus unidades.
    const doc = [
      r.headline ?? "",
      ...jsonArray<string>(r.summary),
      ...jsonArray<{ magnitude?: string; quote?: string | null }>(
        r.attribution,
      ).map((a) => [a.magnitude, a.quote].filter(Boolean).join(" — ")),
    ]
      .filter(Boolean)
      .join("\n");
    if (g) {
      g.ids.push(r.id);
      g.texts.push(r.text);
    } else {
      groups.set(key, {
        session: r.user_session,
        symbol: r.symbol,
        accession: r.accession,
        document: doc,
        ids: [r.id],
        texts: [r.text],
      });
    }
  }

  let tripped = 0;
  let checked = 0;
  for (const g of Array.from(groups.values()).slice(0, maxSymbols)) {
    const results = await checkFalsifiers({
      symbol: g.symbol,
      conditions: g.texts,
      document: g.document,
    });
    // Sin resultado NO se marca nada como comprobado: escribir
    // `checked_accession` aquí daría por evaluado un filing que nadie miró,
    // y la ausencia de alarma se leería como "todo bien".
    if (!results.length) continue;

    for (const r of results) {
      const id = g.ids[r.index];
      if (id === undefined) continue;
      checked++;
      if (r.occurred) {
        tripped++;
        await db.execute(sql`
          UPDATE thesis_falsifiers
             SET tripped_at = now(), tripped_evidence = ${r.evidence},
                 checked_accession = ${g.accession}
           WHERE id = ${id}
        `);
      } else {
        await db.execute(sql`
          UPDATE thesis_falsifiers
             SET checked_accession = ${g.accession}
           WHERE id = ${id}
        `);
      }
    }

    // El grupo ENTERO queda marcado contra este filing, no sólo los índices
    // que el modelo devolvió. El prompt pide "una entrada por condición,
    // mismo orden, mismo número", pero omitir una es un fallo de formato
    // frecuente — y un solo índice ausente dejaba a TODO el grupo elegible
    // en la siguiente pasada, así que el mismo comunicado se re-pagaba en
    // cada tick del cron indefinidamente. Justo lo que `checked_accession`
    // existe para impedir ("un filing se paga UNA vez por símbolo").
    //
    // Marcarlo es defendible porque la llamada SÍ ocurrió y devolvió algo
    // utilizable: el prompt DEFAULTEA A FALSE ("I cannot tell from this
    // document" es false), así que la ausencia de una entrada se lee igual
    // que la entrada que habría venido. Nunca se marca cuando la llamada
    // falló entera: ése es el `continue` de arriba.
    const omitidos = g.ids.filter(
      (_, i) => !results.some((r) => r.index === i),
    );
    if (omitidos.length) {
      console.warn(
        `[coach] ${g.symbol}: el modelo omitió ${omitidos.length}/${g.ids.length} condiciones — se marcan como comprobadas contra ${g.accession} para no re-pagar el mismo filing cada tick`,
      );
      await db.execute(sql`
        UPDATE thesis_falsifiers
           SET checked_accession = ${g.accession}
         WHERE id IN (${sql.join(
           omitidos.map((id) => sql`${id}`),
           sql`, `,
         )})
      `);
    }
  }

  return { symbols: groups.size, tripped, checked };
}
