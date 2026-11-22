import type { RunStatus } from "@luma/shared";
import { cn } from "@/lib/utils";

export function SessionRows({ sessions, selectedSessionId, onSelectSession }: {
  sessions: { id: string; title: string; status: RunStatus; running?: boolean; needsReview?: boolean }[];
  selectedSessionId: string | null;
  onSelectSession(id: string): void;
}): JSX.Element | null {
  if (!sessions.length) return null;
  return (
    <ul className="space-y-0.5">
      {sessions.map(({ id, title, status, running = status === "running", needsReview }) => (
        <li key={id}>
          <button
            type="button"
            className={cn(
              "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:outline focus-visible:outline-brand",
              selectedSessionId === id ? "bg-brand-soft text-brand" : "text-foreground/80 hover:bg-control-hover",
              needsReview && "font-bold",
            )}
            aria-current={selectedSessionId === id ? "true" : undefined}
            aria-description={needsReview ? "Ready to review" : running ? "Running" : undefined}
            onClick={() => onSelectSession(id)}
            title={`${title || "Session"} · ${status}${needsReview ? " · Ready to review" : ""}`}
          >
            <span className="relative flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
              {running ? <span className="absolute inset-0 rounded-full border border-brand/70 motion-safe:animate-spin motion-safe:border-r-transparent" /> : null}
              <span className={cn(
                "h-1.5 w-1.5 rounded-full",
                running || status === "queued" ? "bg-brand" : status === "failed" ? "bg-danger-fg" : "bg-foreground/30",
              )} />
            </span>
            <span className="min-w-0 flex-1 truncate" dir="auto">{title || "Session"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
