import { CATEGORY_META, type NewsCategory } from "@/lib/categorizer";
import { cn } from "@/lib/utils";

export function CategoryBadge({
  value,
  className,
}: {
  value: NewsCategory | null | undefined;
  className?: string;
}) {
  if (!value) return null;
  const meta = CATEGORY_META[value];
  if (!meta) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em]",
        meta.tone,
        className,
      )}
      title={`Category: ${value}`}
    >
      {meta.label}
    </span>
  );
}
