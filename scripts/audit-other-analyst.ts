// Audita news category=OTHER recientes buscando indicios de que en
// realidad son ANALYST/RATING. Imprime 50 headlines con scoring textual
// para que el humano valide qué patrones añadir al categorizer.
//
//   pnpm tsx scripts/audit-other-analyst.ts

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const HINTS: Array<{ name: string; re: RegExp }> = [
  { name: "PT/price target", re: /\b(price target|target price|PT to|\$\d+ price target|target of \$\d+|raised PT|cut PT|adjusts PT|new PT|sets PT)\b/i },
  { name: "rating verb", re: /\b(upgraded?|downgraded?|reiterates?|maintains?|initiates?|reaffirms?|reaffirmed)\b/i },
  { name: "rating label", re: /\b(buy rating|sell rating|hold rating|outperform|underperform|overweight|underweight|market perform|equal[- ]weight|sector perform|strong buy|strong sell)\b/i },
  { name: "coverage", re: /\b(coverage (initiated|started|begun|resumed)|begins? coverage|starts? coverage|initiates? coverage|resumes? coverage|drops? coverage)\b/i },
  { name: "analyst keyword", re: /\b(analyst (note|report|outlook|view|call|forecast|estimate)|wall street analyst|consensus (rating|estimate|target|price target)|broker(?:age)? (note|report|view|raises|cuts))\b/i },
  { name: "estimate change", re: /\b(raises? estimates?|cuts? estimates?|lifts? estimates?|lowers? estimates?|trims? estimates?|boosts? estimates?|estimate (raised|cut|lifted|lowered|trimmed|boosted))\b/i },
  { name: "stock pick wording", re: /\b(top pick|stock pick|stocks? to (buy|watch|own)|conviction (list|buy)|focus list|best ideas?|highest conviction)\b/i },
  { name: "Bernstein/Wolfe-ish firm + verb", re: /\b(Bernstein|Wolfe|Loop Capital|Roth|Roth MKM|Stifel|Wedbush|Piper Sandler|TD Cowen|Cowen|Oppenheimer|Jefferies|HC Wainwright|Susquehanna|Citi|Citigroup|Barclays|UBS|Morgan Stanley|Goldman|BofA|Bank of America|JPMorgan|JP Morgan|Wells Fargo|Mizuho|RBC|BMO|Truist|Raymond James|KBW|BTIG|Cantor|Needham|Baird|Evercore|Macquarie|Argus|Morningstar|Benchmark|Rosenblatt|Seaport|Guggenheim|Janney|William Blair|Bernstein|Hana Securities)\b.*\b(raises?|cuts?|lifts?|lowers?|boosts?|trims?|hikes?|sees|maintains?|reiterates?|upgrades?|downgrades?|initiates?|reaffirms?|drops?|sets?|adjusts?|reduces?|increases?|starts?|begins?|names?|calls?|rates?)\b/i },
  { name: "Reaffirms/Reiterates X on Y", re: /\b(reiterat|reaffirm|maintain).{0,30}(buy|sell|hold|outperform|underperform|overweight|underweight|neutral|market perform)\b/i },
  { name: "Stock to / Buy alert", re: /\b(buy alert|sell alert|stock (alert|warning)|3 (stocks?|companies)|top (3|5|10) stocks?|best stocks?)\b/i },
];

async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const rows = await db.execute(sql`
    SELECT id, headline, source, published_at
    FROM news
    WHERE category = 'OTHER'
      AND published_at > NOW() - INTERVAL '7 days'
    ORDER BY published_at DESC
  `);
  const items = unwrapRows<{ id: number; headline: string; source: string; published_at: Date }>(rows);
  console.log(`[audit] scanning ${items.length} OTHER news (last 7d)\n`);

  const hitCounts = new Map<string, number>();
  const samples = new Map<string, string[]>();
  let totalSuspect = 0;

  for (const r of items) {
    const matched: string[] = [];
    for (const h of HINTS) if (h.re.test(r.headline)) matched.push(h.name);
    if (!matched.length) continue;
    totalSuspect++;
    for (const m of matched) {
      hitCounts.set(m, (hitCounts.get(m) ?? 0) + 1);
      const arr = samples.get(m) ?? [];
      if (arr.length < 6) {
        arr.push(`  [${r.id}] ${r.source} — ${r.headline.slice(0, 110)}`);
        samples.set(m, arr);
      }
    }
  }

  console.log(`Suspect OTHER → ANALYST: ${totalSuspect}/${items.length} (${((totalSuspect / Math.max(1, items.length)) * 100).toFixed(1)}%)\n`);
  console.log("By hint pattern:");
  for (const [name, n] of [...hitCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`\n${name} — ${n} hits`);
    for (const s of samples.get(name) ?? []) console.log(s);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
