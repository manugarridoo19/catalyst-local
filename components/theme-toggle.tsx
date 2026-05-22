"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

// Toggle dark ↔ light. Mantenemos shape de botón consistente con los
// otros botones del header (border rounded-md font-mono). Hydration-safe:
// el primer render renderiza neutro hasta que `mounted` flag confirma
// el theme del cliente (sino hay flash dark→light en SSR).
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";
  const next = isDark ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-card/50 text-muted-foreground transition-colors duration-150",
        "hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary",
      )}
    >
      {/* Sin mounted, evitamos render-mismatch SSR vs cliente. */}
      {!mounted ? (
        <span className="h-3.5 w-3.5" />
      ) : isDark ? (
        <Sun className="h-3.5 w-3.5" strokeWidth={2} />
      ) : (
        <Moon className="h-3.5 w-3.5" strokeWidth={2} />
      )}
    </button>
  );
}
