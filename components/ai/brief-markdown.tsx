import type { ReactNode } from "react";

// Renderer markdown-lite compartido por el AI Brief global (BriefPanel) y
// el Ticker Day Brief. Solo soporta lo que los prompts permiten emitir:
// bullets ("- ", "• ", "* "), negritas **X** y líneas sueltas como párrafo
// (el ticker brief abre con un párrafo lead). Nada de dangerouslySetInnerHTML.

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong
        key={i}
        className="font-mono text-[0.95em] font-bold tracking-wide text-primary"
      >
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

const BULLET_RE = /^[-•*]\s+/;

export function BriefMarkdown({ content }: { content: string }) {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <div className="space-y-2.5">
      {lines.map((line, i) => {
        if (!BULLET_RE.test(line)) {
          return (
            <p
              key={i}
              className="font-editorial text-[13.5px] leading-relaxed text-foreground"
            >
              {renderInline(line)}
            </p>
          );
        }
        const bullet = line.replace(BULLET_RE, "");
        const isWatchlist = bullet.startsWith("⭐");
        const text = isWatchlist ? bullet.replace(/^⭐\s*/, "") : bullet;
        return (
          <div
            key={i}
            className={
              isWatchlist
                ? "border-l-2 border-primary/70 pl-3 text-foreground"
                : "border-l-2 border-border/40 pl-3 text-foreground/90"
            }
          >
            {isWatchlist ? (
              <span className="eyebrow-sm mr-2 text-primary">watchlist</span>
            ) : null}
            <span className="font-editorial text-[13.5px] leading-relaxed">
              {renderInline(text)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
