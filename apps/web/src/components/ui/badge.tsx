import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-card-border bg-white/90 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-foreground/70",
        className,
      )}
    >
      {children}
    </span>
  );
}
