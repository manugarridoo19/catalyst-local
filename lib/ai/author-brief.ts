import { sql, desc, eq } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { authorBriefs } from "@/lib/db/schema";
import { chatCompletion } from "@/lib/providers/openrouter";
import { geminiChatCompletion, getGeminiPoolStatus } from "@/lib/providers/gemini";
import { groqChatCompletion } from "@/lib/providers/groq";
import { cleanModelProse, looksLikeScratchpad } from "@/lib/ai/guards";

// Author Watch — la "super sección". Una vez al día fusiona lo que el autor
// (@Couch_Investor) dijo en X el día anterior con nuestro tape de noticias
// puntuadas de los tickers que mencionó. Pocos stocks, muy cargados.
//
// Modelo: cadena task="author" con reasoning ACTIVADO (petición explícita
// del usuario — "un buen modelo con reasoning es esencial"). Coste 1 call/
// día lo permite. Fallbacks: gemini (thinking) → groq 70b. Guard
// anti-scratchpad descarta fugas de razonamiento y conserva el brief previo.

const KEEP_LAST = 30;

const AUTHOR_SYSTEM_PROMPT = `You are an equities analyst building a daily "author desk" for an investor who follows a specific market commentator on X. You receive: (1) the author's tweets from the last day, and (2) our own scored news tape (impact 1-5, sentiment -5..+5) for the tickers the author mentioned.
Your job: fuse the two into a tight briefing focused ONLY on the stocks the author actually talked about with substance. For each such stock, say what the AUTHOR is arguing, then what OUR tape shows, and flag any divergence between the two.

Output ONLY a JSON object:
{"intro": "...", "stocks": [{"symbol":"NVDA","authorTake":"...","tapeContext":"...","divergence":"..."}]}
Rules:
- "intro": 1-2 sentences on the author's overall stance/mood for the day. Plain, factual.
- "stocks": ONLY tickers the author discussed with a view (not a passing cashtag, not pure retweets with no comment). 2-6 max, most important first. If the author gave no real stock views, return an empty stocks array and say so in the intro.
- "authorTake": 1-2 sentences — what the author claimed/argued about this stock. Ground it in their tweets; quote a phrase if useful. Never invent.
- "tapeContext": 1-2 sentences — what OUR news tape shows for this stock (catalysts, impact, sentiment). If our tape has nothing, say "no matching coverage in our tape today." Never invent numbers.
- "divergence": include ONLY when the author's view and our tape point different directions (e.g. author bullish, tape shows negative catalysts); one sentence. Omit the field otherwise.
- Be strictly factual. Use ONLY the provided tweets and tape. No investment advice, no outside knowledge.`;

export type AuthorStock = {
  symbol: string;
  authorTake: string;
  tapeContext: string;
  divergence?: string;
};
export type AuthorBriefContent = {
  intro: string;
  stocks: AuthorStock[];
};

export type AuthorBriefRow = {
  id: number;
  author: string;
  content: AuthorBriefContent;
  model: string;
  tweetCount: number;
  coveredDate: string;
  generatedAt: Date;
};

function parseRow(r: {
  id: number;
  author: string;
  content: string;
  model: string;
  tweetCount: number;
  coveredDate: string;
  generatedAt: Date;
}): AuthorBriefRow | null {
  try {
    const content = JSON.parse(r.content) as AuthorBriefContent;
    if (!content || !Array.isArray(content.stocks)) return null;
    return { ...r, content };
  } catch {
    return null;
  }
}

export async function getLatestAuthorBrief(
  author: string,
): Promise<AuthorBriefRow | null> {
  const rows = await db
    .select()
    .from(authorBriefs)
    .where(eq(authorBriefs.author, author))
    .orderBy(desc(authorBriefs.generatedAt))
    .limit(1);
  return rows[0] ? parseRow(rows[0]) : null;
}

type TweetRow = {
  text: string;
  created_at: string | Date;
  is_retweet: number;
  tickers: string[];
};
type TapeRow = {
  ticker: string;
  headline: string;
  impact: number;
  sentiment: number;
  category: string | null;
};

// Cadena de reasoning para el author brief. OpenRouter task="author" con
// reasoning:true primero; si el pool está agotado, gemini y groq como red.
async function authorCompletion(userPrompt: string) {
  const messages = [
    { role: "system" as const, content: AUTHOR_SYSTEM_PROMPT },
    { role: "user" as const, content: userPrompt },
  ];
  try {
    return await chatCompletion({
      messages,
      task: "author",
      temperature: 0.4,
      maxTokens: 2200, // holgado: reasoning consume tokens antes del JSON
      jsonMode: true,
      reasoning: true,
      timeoutMs: 90_000,
    });
  } catch (err) {
    console.warn(
      "[author-brief] openrouter reasoning chain failed, falling back:",
      err instanceof Error ? err.message.slice(0, 120) : err,
    );
  }
  if (getGeminiPoolStatus().total > 0) {
    try {
      return await geminiChatCompletion({
        messages,
        temperature: 0.4,
        maxTokens: 1600,
        jsonMode: true,
        timeoutMs: 40_000,
      });
    } catch (err) {
      console.warn(
        "[author-brief] gemini fallback failed:",
        err instanceof Error ? err.message.slice(0, 120) : err,
      );
    }
  }
  return await groqChatCompletion({
    messages,
    model: "llama-3.3-70b-versatile",
    temperature: 0.4,
    maxTokens: 1600,
    jsonMode: true,
    timeoutMs: 30_000,
    retries: 1,
  });
}

// Genera el brief del día para un autor. Lanza si no hay tweets con sustancia.
export async function generateAuthorBrief(
  author: string,
): Promise<AuthorBriefRow> {
  // Tweets del último día (excluye RTs sin comentario para el foco de stocks,
  // pero se los pasamos al modelo igual para contexto de mood).
  const tweets = unwrapRows<TweetRow>(
    await db.execute(sql`
      SELECT text, created_at, is_retweet, tickers
      FROM author_tweets
      WHERE author = ${author}
        AND created_at >= now() - interval '30 hours'
      ORDER BY created_at DESC
      LIMIT 80
    `),
  );
  if (tweets.length === 0) {
    throw new Error(`no recent tweets for ${author}`);
  }

  // Universo de tickers que el autor mencionó (cashtags ya extraídos).
  const mentioned = new Set<string>();
  for (const t of tweets) for (const s of t.tickers ?? []) mentioned.add(s);

  // Tape 24h de esos tickers (si mencionó alguno). Top por impacto.
  let tape: TapeRow[] = [];
  if (mentioned.size) {
    const list = sql.join(
      [...mentioned].map((s) => sql`${s}`),
      sql`, `,
    );
    tape = unwrapRows<TapeRow>(
      await db.execute(sql`
        SELECT nt.ticker, n.headline, s.impact, s.sentiment, n.category
        FROM news_tickers nt
        JOIN news n ON n.id = nt.news_id
        JOIN news_scores s ON s.news_id = n.id
        WHERE nt.ticker IN (${list})
          AND n.published_at >= now() - interval '24 hours'
        ORDER BY s.impact DESC, n.published_at DESC
        LIMIT 60
      `),
    );
  }

  const tweetLines = tweets.map((t) => {
    const when = new Date(t.created_at).toISOString().slice(5, 16).replace("T", " ");
    const rt = t.is_retweet ? "[RT] " : "";
    const tk = (t.tickers ?? []).length ? ` {${(t.tickers ?? []).join(",")}}` : "";
    return `- ${when}Z ${rt}${t.text.replace(/\s+/g, " ").trim()}${tk}`;
  });

  const tapeByTicker = new Map<string, TapeRow[]>();
  for (const r of tape) {
    const l = tapeByTicker.get(r.ticker) ?? [];
    l.push(r);
    tapeByTicker.set(r.ticker, l);
  }
  const tapeLines: string[] = [];
  for (const [ticker, rows] of tapeByTicker) {
    tapeLines.push(`${ticker}:`);
    for (const r of rows.slice(0, 8)) {
      const sent = r.sentiment > 0 ? `+${r.sentiment}` : `${r.sentiment}`;
      tapeLines.push(`  - [imp=${r.impact} sent=${sent} ${r.category ?? "?"}] ${r.headline}`);
    }
  }

  const userPrompt = [
    `Author: @${author}`,
    ``,
    `Author's tweets, last day (newest first; {TICKERS} = cashtags they used):`,
    ...tweetLines,
    ``,
    mentioned.size
      ? `Our news tape (last 24h) for the tickers the author mentioned:`
      : `The author mentioned no cashtags today; no tape to attach.`,
    ...tapeLines,
  ].join("\n");

  const result = await authorCompletion(userPrompt);

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      cleanModelProse(result.content).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""),
    );
  } catch {
    throw new Error(
      `author brief unparseable: "${result.content.slice(0, 140)}"`,
    );
  }
  const obj = parsed as Partial<AuthorBriefContent>;
  if (!obj || typeof obj.intro !== "string" || !Array.isArray(obj.stocks)) {
    throw new Error("author brief missing intro/stocks");
  }
  if (looksLikeScratchpad(obj.intro)) {
    throw new Error("author brief intro looks like scratchpad — discarded");
  }

  // Sanea: symbol upper, strings recortados, quita stocks sin authorTake.
  const stocks: AuthorStock[] = [];
  for (const s of obj.stocks) {
    if (!s || typeof s !== "object") continue;
    const symbol = String((s as AuthorStock).symbol ?? "").toUpperCase().trim();
    const authorTake = String((s as AuthorStock).authorTake ?? "").trim();
    const tapeContext = String((s as AuthorStock).tapeContext ?? "").trim();
    if (!symbol || authorTake.length < 10) continue;
    let divergence = String((s as AuthorStock).divergence ?? "").trim();
    // Los modelos a veces rellenan el campo con "N/A"/"none"/"n/a" en vez de
    // omitirlo — trátalo como ausente para no pintar un aviso vacío.
    if (/^(n\/?a|none|no divergence|n\.a\.?|-|—)[.\s]*$/i.test(divergence))
      divergence = "";
    stocks.push({
      symbol: symbol.slice(0, 10),
      authorTake: authorTake.slice(0, 500),
      tapeContext: tapeContext.slice(0, 500),
      ...(divergence ? { divergence: divergence.slice(0, 300) } : {}),
    });
  }

  const content: AuthorBriefContent = {
    intro: obj.intro.trim().slice(0, 600),
    stocks,
  };
  const coveredDate = new Date(new Date(tweets[0].created_at))
    .toISOString()
    .slice(0, 10);

  const inserted = await db
    .insert(authorBriefs)
    .values({
      author,
      content: JSON.stringify(content),
      model: result.model,
      tweetCount: tweets.length,
      coveredDate,
    })
    .returning();

  await db.execute(sql`
    DELETE FROM author_briefs
    WHERE author = ${author} AND id NOT IN (
      SELECT id FROM author_briefs WHERE author = ${author}
      ORDER BY generated_at DESC LIMIT ${KEEP_LAST}
    )
  `);

  return parseRow(inserted[0])!;
}
