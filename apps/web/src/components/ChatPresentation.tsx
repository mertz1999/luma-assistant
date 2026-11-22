import { isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveTextDirection } from "@/lib/textDirection";
import { cn } from "@/lib/utils";

export const chatHeaderClass = "relative z-10 hidden h-12 shrink-0 items-center justify-between gap-3 bg-background/95 px-4 shadow-[0_14px_32px_-28px_rgba(0,0,0,0.95)] lg:flex";
export const chatTimelineClass = "scrollbar-thin min-h-0 flex-1 overflow-auto px-4 pb-4 pt-4 lg:px-8";
export const chatEntriesClass = "mx-auto flex w-full max-w-5xl flex-col gap-5";
export const chatComposerClass = "relative shrink-0 bg-background px-4 py-3 shadow-[0_-16px_34px_-30px_rgba(0,0,0,0.95)] transition lg:px-8";

type MessageRole = "user" | "assistant" | "plan" | "system" | "error" | "tool";

export function chatMessageAlignment(role: MessageRole): string {
  return cn("flex w-full flex-col animate-fade-up", role === "user" ? "items-end" : role === "system" ? "items-center" : "items-start");
}

export function chatMessageClass(role: MessageRole, failed: boolean): string {
  return cn(
    "relative shadow-none",
    role === "user" && "ml-auto max-w-[min(760px,82%)] rounded-lg border border-card-border bg-control px-3 py-2 text-foreground",
    role === "user" && failed && "border-rose-500/60 bg-danger-bg text-danger-fg",
    role === "assistant" && "mr-auto w-full bg-transparent px-0 py-0 text-foreground/90",
    role === "plan" && "mr-auto w-full rounded-md border border-card-border bg-surface-1 px-3 py-2",
    role === "tool" && "w-full bg-transparent px-0 py-0",
    role === "system" && "mx-auto max-w-fit rounded-md border border-card-border bg-surface-1 px-3 py-1 text-xs text-foreground/75",
    role === "error" && "mr-auto max-w-[90%] rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-rose-900 dark:border-danger-fg/40 dark:bg-danger-bg/90 dark:text-danger-fg",
  );
}

function flattenMarkdownText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => flattenMarkdownText(child)).join("");
  }
  if (isValidElement(children)) {
    return flattenMarkdownText(children.props.children);
  }
  return "";
}

export function MarkdownMessage({ text, allowImages = true }: { text: string; allowImages?: boolean }): JSX.Element {
  const direction = resolveTextDirection(text);
  return (
    <div className="rich-text" dir={direction} lang={direction === "rtl" ? "fa" : undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={allowImages ? undefined : ["img"]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="mb-2 text-lg font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 text-base font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 text-sm font-semibold">{children}</h3>,
          ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 ps-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 ps-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-s-2 border-foreground/30 ps-3 italic text-foreground/80">{children}</blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark dark:text-[#8fc5ff] dark:hover:text-[#bddcff]"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="claude-table my-2 overflow-x-auto rounded-md">
              <table className="min-w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="px-2 py-1.5 text-start font-semibold text-foreground/80">{children}</th>,
          td: ({ children }) => <td className="px-2 py-1.5 align-top text-start text-foreground/90">{children}</td>,
          code: ({ className, children }) => {
            const raw = flattenMarkdownText(children).replace(/\n$/, "");
            const isBlock = Boolean(className) || raw.includes("\n");
            return (
              <code
                className={cn(
                  isBlock
                    ? "block whitespace-pre-wrap break-words bg-transparent font-mono text-[0.95em] leading-relaxed text-foreground"
                    : "rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.92em] text-foreground",
                  className,
                )}
                dir="ltr"
              >
                {raw}
              </code>
            );
          },
          pre: ({ children }) => <pre className="my-1.5 overflow-x-auto rounded-md border border-card-border bg-surface-2 px-3 py-2" dir="ltr">{children}</pre>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function ThinkingDots({ label = "Thinking" }: { label?: string }): JSX.Element {
  return (
    <div className="inline-flex items-center gap-2 text-sm text-foreground/70">
      <span className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_0_3px_rgba(234,111,55,0.12)]" />
      <span className="font-medium">{label}</span>
      <span className="dot-wave" aria-label={`${label} in progress`} role="status">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </div>
  );
}
