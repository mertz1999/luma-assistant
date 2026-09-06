import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
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
import { getApiAuthToken } from "@/lib/api";
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

type ServerMessage =
  | { type: "ready"; sessionId: string; width: number; height: number }
  | { type: "navigated"; url: string; title?: string }
  | { type: "frame"; data: string; metadata?: { deviceWidth?: number; deviceHeight?: number } }
  | { type: "status"; loading: boolean }
  | { type: "error"; message: string };

function buildPreviewBrowserWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = getApiAuthToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${protocol}//${window.location.host}/api/preview-browser${query}`;
}

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
  const [connectionState, setConnectionState] = useState<"connecting" | "ready" | "error">("connecting");
  const [statusText, setStatusText] = useState("Starting Playwright browser…");
  const [loading, setLoading] = useState(false);
  const [pageTitle, setPageTitle] = useState("");
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const viewportSizeRef = useRef({ width: 1280, height: 800 });
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setDraftUrl(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    let cancelled = false;
    readyRef.current = false;
    setConnectionState("connecting");
    setStatusText("Starting Playwright browser…");
    setPageTitle("");

    const socket = new WebSocket(buildPreviewBrowserWsUrl());
    socketRef.current = socket;

    const send = (payload: Record<string, unknown>): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(payload));
    };

    const syncViewport = (): void => {
      const node = viewportRef.current;
      if (!node) return;
      const width = Math.max(320, Math.floor(node.clientWidth));
      const height = Math.max(240, Math.floor(node.clientHeight));
      viewportSizeRef.current = { width, height };
      send({ type: "resize", width, height });
    };

    socket.addEventListener("open", () => {
      if (cancelled) return;
      setStatusText("Browser connected");
      syncViewport();
      if (previewUrl) {
        setLoading(true);
        send({ type: "navigate", url: previewUrl });
      }
    });

    socket.addEventListener("message", (event) => {
      if (cancelled) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "ready") {
        readyRef.current = true;
        setConnectionState("ready");
        setStatusText("Playwright ready");
        viewportSizeRef.current = { width: message.width, height: message.height };
        if (previewUrl) {
          setLoading(true);
          send({ type: "navigate", url: previewUrl });
        }
        return;
      }

      if (message.type === "navigated") {
        setDraftUrl(message.url);
        setPageTitle(message.title || "");
        return;
      }

      if (message.type === "status") {
        setLoading(message.loading);
        return;
      }

      if (message.type === "error") {
        setConnectionState("error");
        setStatusText(message.message);
        setLoading(false);
        return;
      }

      if (message.type === "frame") {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const img = imageRef.current || new Image();
        imageRef.current = img;
        img.onload = () => {
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
          }
          ctx.drawImage(img, 0, 0);
        };
        img.src = `data:image/jpeg;base64,${message.data}`;
      }
    });

    socket.addEventListener("close", () => {
      if (cancelled) return;
      readyRef.current = false;
      setConnectionState("error");
      setStatusText("Preview browser disconnected");
      setLoading(false);
    });

    socket.addEventListener("error", () => {
      if (cancelled) return;
      setConnectionState("error");
      setStatusText("Preview browser connection failed");
    });

    const onResize = (): void => {
      if (!readyRef.current) return;
      syncViewport();
    };
    window.addEventListener("resize", onResize);
    const ro = typeof ResizeObserver !== "undefined" && viewportRef.current
      ? new ResizeObserver(() => onResize())
      : null;
    if (viewportRef.current && ro) ro.observe(viewportRef.current);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
    // Recreate browser session when panel remounts / reload token changes.
  }, [previewReloadToken]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !readyRef.current) return;
    if (!previewUrl) return;
    setLoading(true);
    socket.send(JSON.stringify({ type: "navigate", url: previewUrl }));
  }, [previewUrl]);

  const canGoBack = previewHistoryIndex > 0;
  const canGoForward = previewHistoryIndex >= 0 && previewHistoryIndex < previewHistory.length - 1;
  const recentSuggestions = previewRecents.filter((url) => url !== previewUrl).slice(0, 5);

  function sendClient(payload: Record<string, unknown>): void {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  function mapPointer(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * (canvas.width || viewportSizeRef.current.width);
    const y = ((event.clientY - rect.top) / rect.height) * (canvas.height || viewportSizeRef.current.height);
    return { x, y };
  }

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

  function onDraftKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
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
    socketRef.current?.close();
    if (onClose) {
      onClose();
      return;
    }
    closePreview();
  }

  function openExternally(): void {
    if (!previewUrl) return;
    window.open(previewUrl, "_blank", "noopener,noreferrer");
  }

  function onToolbarBack(): void {
    goPreviewBack();
    sendClient({ type: "back" });
  }

  function onToolbarForward(): void {
    goPreviewForward();
    sendClient({ type: "forward" });
  }

  function onToolbarReload(): void {
    reloadPreview();
    sendClient({ type: "reload" });
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

  function onCanvasPointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const point = mapPointer(event);
    if (!point) return;
    const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    sendClient({
      type: "pointer",
      event: "down",
      x: point.x,
      y: point.y,
      button,
      clickCount: event.detail || 1,
    });
  }

  function onCanvasPointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const point = mapPointer(event);
    if (!point) return;
    sendClient({ type: "pointer", event: "move", x: point.x, y: point.y });
  }

  function onCanvasPointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const point = mapPointer(event);
    if (!point) return;
    const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    sendClient({
      type: "pointer",
      event: "up",
      x: point.x,
      y: point.y,
      button,
      clickCount: event.detail || 1,
    });
  }

  function onCanvasWheel(event: ReactWheelEvent<HTMLCanvasElement>): void {
    event.preventDefault();
    const point = mapPointer(event);
    if (!point) return;
    sendClient({
      type: "pointer",
      event: "wheel",
      x: point.x,
      y: point.y,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
    });
  }

  function onCanvasKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      // Let browser shortcuts alone except basic editing keys we forward.
    }
    event.preventDefault();
    sendClient({
      type: "key",
      event: "down",
      key: event.key,
      code: event.code,
    });
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
          <span className="hidden truncate text-[10px] text-foreground/45 sm:inline">Playwright</span>

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
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onToolbarBack} disabled={!canGoBack} aria-label="Back" title="Back">
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onToolbarForward} disabled={!canGoForward} aria-label="Forward" title="Forward">
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onToolbarReload} disabled={!previewUrl} aria-label="Reload" title="Reload">
              <RefreshCw className={cn("h-3.5 w-3.5", loading ? "animate-spin" : "")} />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={openExternally} disabled={!previewUrl} aria-label="Open in system browser" title="Open externally">
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleClose} aria-label="Close preview" title="Close">
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
          <span className="ml-auto max-w-[50%] truncate text-[10px] text-foreground/45" title={pageTitle || statusText}>
            {connectionState === "ready" ? (pageTitle || statusText) : statusText}
          </span>
        </div>
      </div>

      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-[#1a1a1a]">
        {!previewUrl ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Globe className="h-8 w-8 text-foreground/35" />
            <p className="text-sm font-medium">Preview a local app</p>
            <p className="max-w-sm text-xs text-foreground/60">
              Enter a URL like <span className="font-mono">localhost:3000</span>. It opens in a server-side Playwright browser.
            </p>
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              className="h-full w-full cursor-crosshair touch-none object-contain outline-none"
              tabIndex={0}
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              onWheel={onCanvasWheel}
              onKeyDown={onCanvasKeyDown}
            />
            {connectionState !== "ready" || loading ? (
              <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/50 px-3 py-1 text-center text-[11px] text-white/90">
                {loading ? "Loading…" : statusText}
              </div>
            ) : null}
          </>
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
