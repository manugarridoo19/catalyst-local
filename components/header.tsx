import { Activity } from "lucide-react";

export function Header() {
  return (
    <header className="flex items-center justify-between border-b border-border bg-card/30 px-6 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-amber-400 text-background">
          <Activity className="h-4 w-4" />
        </div>
        <div>
          <div className="font-mono text-sm font-bold uppercase tracking-widest text-foreground">
            Catalyst
          </div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Realtime market news · v0
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="hidden sm:inline">Press</span>
        <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]">
          ⌘K
        </kbd>
        <span className="hidden sm:inline">to search</span>
      </div>
    </header>
  );
}
