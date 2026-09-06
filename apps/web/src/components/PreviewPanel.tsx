import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  PanelTop,
  RefreshCw,
  Columns2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildPreviewFrameSrc, isLoopbackPreviewUrl, pageNeedsPreviewProxy } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  normalizePreviewUrl,
  PREVIEW_HEIGHT_BOUNDS,
  useUiStore,
  type PreviewMode,
} from "@/store/useUiStore";

const PRESET_URLS = [
  { label: "Task Manager", url: "http://localhost:5175/taskmanager" },
  { label: "Luma", url: "http://localhost:5175" },
  { label: ":3000", url: "http://localhost:3000" },
  { label: ":5173", url: "http://localhost:5173" },
  { label: ":8080", url: "http://localhost:8080" },
] as const;

type PreviewPanelProps = {
  layout: PreviewMode;
  className?: string;
  onClose?: () => void;
};

export function PreviewPanel({ layout, className, onClose }: PreviewPanelProps): JSX.Element {
  const {
    previewUrl,
    previewHeight,
    previewHistory,
    previewHistoryIndex,
    previewRecents,
    previewReloadToken,
    previewMode,
    setPreviewMode,
    setPreviewHeight,
    navigatePreview,
    goPreviewBack,
    goPreviewForward,
    reloadPreview,
    openPreview,
    closePreview,
  } = useUiStore();

  const [draftUrl, setDraftUrl] = useState(previewUrl);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    setDraftUrl(previewUrl);
  }, [previewUrl]);

  const canGoBack = previewHistoryIndex > 0;
  const canGoForward = previewHistoryIndex >= 0 && previewHistoryIndex < previewHistory.length - 1;
  const recentSuggestions = previewRecents.filter((url) => url !== previewUrl).slice(0, 5);
  const frameSrc = buildPreviewFrameSrc(previewUrl);
  const usingServerProxy = Boolean(previewUrl && pageNeedsPreviewProxy() && isLoopbackPreviewUrl(previewUrl));

  function commitUrl(raw: string): void {
    const normalized = normalizePreviewUrl(raw);
    if (!normalized) return;
    navigatePreview(normalized);
    setDraftUrl(normalized);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    commitUrl(draftUrl);
  }

  function onDraftKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      setDraftUrl(previewUrl);
      event.currentTarget.blur();
    }
  }

  function switchMode(mode: PreviewMode): void {
    if (mode === "dock") {
      openPreview("dock");
      return;
    }
    setPreviewMode("top");
    openPreview("top");
  }

  function handleClose(): void {
    if (onClose) {
      onClose();
      return;
    }
    closePreview();
  }

  function openExternally(): void {
    const src = frameSrc || previewUrl;
    if (!src) return;
    window.open(src, "_blank", "noopener,noreferrer");
  }

  function onResizePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    resizeStateRef.current = { startY: event.clientY, startHeight: previewHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onResizePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const state = resizeStateRef.current;
    if (!state) return;
    const next = state.startHeight + (event.clientY - state.startY);
    setPreviewHeight(next);
  }

  function onResizePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!resizeStateRef.current) return;
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-surface-1",
        layout === "top" ? "relative shrink-0 border-b border-card-border" : "h-full",
        className,
      )}
      style={layout === "top" ? { height: previewHeight } : undefined}
    >
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-card-border px-2 py-2">
        <div className="flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5 shrink-0 text-brand" />
          <span className="mr-1 shrink-0 text-xs font-semibold">Preview</span>

          <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-card-border bg-control p-0.5">
            <button
              type="button"
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition",
                previewMode === "top" ? "bg-control-hover text-foreground" : "text-foreground/55 hover:text-foreground",
              )}
              onClick={() => switchMode("top")}
              title="Top split"
              aria-pressed={previewMode === "top"}
            >
              <PanelTop className="h-3 w-3" />
              Top
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition",
                previewMode === "dock" ? "bg-control-hover text-foreground" : "text-foreground/55 hover:text-foreground",
              )}
              onClick={() => switchMode("dock")}
              title="Right dock"
              aria-pressed={previewMode === "dock"}
            >
              <Columns2 className="h-3 w-3" />
              Dock
            </button>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={goPreviewBack}
              disabled={!canGoBack}
              aria-label="Back"
              title="Back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={goPreviewForward}
              disabled={!canGoForward}
              aria-label="Forward"
              title="Forward"
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={reloadPreview}
              disabled={!previewUrl}
              aria-label="Reload"
              title="Reload"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={openExternally}
              disabled={!previewUrl}
              aria-label="Open in system browser"
              title="Open externally"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={handleClose}
              aria-label="Close preview"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <form className="flex items-center gap-1.5" onSubmit={onSubmit}>
          <input
            className="h-8 min-w-0 flex-1 rounded-md border border-card-border bg-control px-2.5 font-mono text-xs outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            onKeyDown={onDraftKeyDown}
            placeholder="localhost:3000 or http://..."
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Preview URL"
          />
          <Button type="submit" size="sm" className="h-8 shrink-0 px-3" disabled={!draftUrl.trim()}>
            Go
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-1">
          {PRESET_URLS.map((preset) => (
            <button
              key={preset.url}
              type="button"
              className="rounded border border-card-border bg-control px-1.5 py-0.5 text-[10px] text-foreground/70 transition hover:bg-control-hover hover:text-foreground"
              onClick={() => commitUrl(preset.url)}
              title={preset.url}
            >
              {preset.label}
            </button>
          ))}
          {recentSuggestions.map((url) => (
            <button
              key={url}
              type="button"
              className="max-w-[140px] truncate rounded border border-dashed border-card-border px-1.5 py-0.5 text-[10px] text-foreground/55 transition hover:bg-control hover:text-foreground"
              onClick={() => commitUrl(url)}
              title={url}
            >
              {url.replace(/^https?:\/\//i, "")}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-foreground/45">
            {usingServerProxy
              ? "Via server proxy → this machine’s localhost"
              : "Blank? Open externally — some apps block iframes."}
          </span>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-background">
        {previewUrl ? (
          <iframe
            key={`${frameSrc}::${previewReloadToken}`}
            title="App preview"
            src={frameSrc}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Globe className="h-8 w-8 text-foreground/35" />
            <p className="text-sm font-medium">Preview a local app</p>
            <p className="max-w-sm text-xs text-foreground/60">
              Enter a URL like <span className="font-mono">localhost:3000</span> or pick a preset above.
            </p>
          </div>
        )}
      </div>

      {layout === "top" ? (
        <div
          className="absolute inset-x-0 bottom-0 z-20 flex h-2 cursor-row-resize items-center justify-center"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize preview"
          aria-valuemin={PREVIEW_HEIGHT_BOUNDS.min}
          aria-valuemax={PREVIEW_HEIGHT_BOUNDS.max}
          aria-valuenow={previewHeight}
          title="Drag to resize"
        >
          <div className="h-1 w-10 rounded-full bg-foreground/25" />
        </div>
      ) : null}
    </div>
  );
}
