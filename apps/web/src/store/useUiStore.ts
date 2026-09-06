import { create } from "zustand";

type RightPanelTab = "terminal" | "context" | "preview";
export type PreviewMode = "top" | "dock";

const PREVIEW_RECENTS_KEY = "luma_assistant_preview_recents";
const PREVIEW_URL_KEY = "luma_assistant_preview_url";
const PREVIEW_MODE_KEY = "luma_assistant_preview_mode";
const PREVIEW_HEIGHT_KEY = "luma_assistant_preview_height";
const MAX_RECENTS = 8;
const DEFAULT_PREVIEW_HEIGHT = 360;
const MIN_PREVIEW_HEIGHT = 160;
const MAX_PREVIEW_HEIGHT = 720;

type UiStore = {
  selectedRunId: string | null;
  rightPanelTab: RightPanelTab;
  rightDockOpen: boolean;
  leftSidebarOpen: boolean;
  mobileThreadsOpen: boolean;
  mobileContextOpen: boolean;
  theme: "light" | "dark";
  previewOpen: boolean;
  previewMode: PreviewMode;
  previewUrl: string;
  previewHeight: number;
  previewHistory: string[];
  previewHistoryIndex: number;
  previewRecents: string[];
  previewReloadToken: number;
  setSelectedRunId: (runId: string | null) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setRightDockOpen: (open: boolean) => void;
  setLeftSidebarOpen: (open: boolean) => void;
  setMobileThreadsOpen: (open: boolean) => void;
  setMobileContextOpen: (open: boolean) => void;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
  setPreviewOpen: (open: boolean) => void;
  setPreviewMode: (mode: PreviewMode) => void;
  setPreviewHeight: (height: number) => void;
  navigatePreview: (rawUrl: string) => void;
  goPreviewBack: () => void;
  goPreviewForward: () => void;
  reloadPreview: () => void;
  openPreview: (mode?: PreviewMode) => void;
  closePreview: () => void;
  togglePreview: () => void;
};

function getInitialTheme(): "light" | "dark" {
  if (typeof window !== "undefined") {
    window.localStorage.setItem("luma_assistant_theme", "dark");
    window.localStorage.removeItem("agentic_cli_theme");
    document.documentElement.setAttribute("data-theme", "dark");
  }
  return "dark";
}

function readStoredString(key: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function readStoredRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PREVIEW_RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function readStoredMode(): PreviewMode {
  const value = readStoredString(PREVIEW_MODE_KEY, "top");
  return value === "dock" ? "dock" : "top";
}

function readStoredHeight(): number {
  if (typeof window === "undefined") return DEFAULT_PREVIEW_HEIGHT;
  try {
    const raw = window.localStorage.getItem(PREVIEW_HEIGHT_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_PREVIEW_HEIGHT;
    if (!Number.isFinite(parsed)) return DEFAULT_PREVIEW_HEIGHT;
    return Math.min(MAX_PREVIEW_HEIGHT, Math.max(MIN_PREVIEW_HEIGHT, parsed));
  } catch {
    return DEFAULT_PREVIEW_HEIGHT;
  }
}

function persistString(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore quota / private mode failures
  }
}

/** Normalize typed addresses into absolute http(s) URLs. */
export function normalizePreviewUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  if (trimmed.startsWith("//")) return `http:${trimmed}`;

  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed) || /^127\.0\.0\.1(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  if (/^:\d+(\/.*)?$/.test(trimmed)) {
    return `http://localhost${trimmed}`;
  }

  if (/^\d{2,5}(\/.*)?$/.test(trimmed)) {
    return `http://localhost:${trimmed}`;
  }

  if (/^[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  return null;
}

function pushRecent(recents: string[], url: string): string[] {
  return [url, ...recents.filter((item) => item !== url)].slice(0, MAX_RECENTS);
}

export const useUiStore = create<UiStore>((set, get) => {
  const initialUrl = readStoredString(PREVIEW_URL_KEY);
  const initialRecents = readStoredRecents();

  return {
    selectedRunId: null,
    rightPanelTab: "terminal",
    rightDockOpen: false,
    leftSidebarOpen: true,
    mobileThreadsOpen: false,
    mobileContextOpen: false,
    theme: getInitialTheme(),
    previewOpen: false,
    previewMode: readStoredMode(),
    previewUrl: initialUrl,
    previewHeight: readStoredHeight(),
    previewHistory: initialUrl ? [initialUrl] : [],
    previewHistoryIndex: initialUrl ? 0 : -1,
    previewRecents: initialRecents,
    previewReloadToken: 0,
    setSelectedRunId: (selectedRunId) => set({ selectedRunId }),
    setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
    setRightDockOpen: (rightDockOpen) => set({ rightDockOpen }),
    setLeftSidebarOpen: (leftSidebarOpen) => set({ leftSidebarOpen }),
    setMobileThreadsOpen: (mobileThreadsOpen) => set({ mobileThreadsOpen }),
    setMobileContextOpen: (mobileContextOpen) => set({ mobileContextOpen }),
    setTheme: (theme) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("luma_assistant_theme", "dark");
        window.localStorage.removeItem("agentic_cli_theme");
        document.documentElement.setAttribute("data-theme", theme);
      }
      set({ theme });
    },
    toggleTheme: () => {
      const next = get().theme === "light" ? "dark" : "light";
      get().setTheme(next);
    },
    setPreviewOpen: (previewOpen) => set({ previewOpen }),
    setPreviewMode: (previewMode) => {
      persistString(PREVIEW_MODE_KEY, previewMode);
      set({ previewMode });
    },
    setPreviewHeight: (height) => {
      const previewHeight = Math.min(MAX_PREVIEW_HEIGHT, Math.max(MIN_PREVIEW_HEIGHT, Math.round(height)));
      persistString(PREVIEW_HEIGHT_KEY, String(previewHeight));
      set({ previewHeight });
    },
    navigatePreview: (rawUrl) => {
      const url = normalizePreviewUrl(rawUrl);
      if (!url) return;

      const { previewHistory, previewHistoryIndex, previewRecents } = get();
      const truncated = previewHistory.slice(0, Math.max(previewHistoryIndex + 1, 0));
      const nextHistory = truncated[truncated.length - 1] === url ? truncated : [...truncated, url];
      const nextIndex = nextHistory.length - 1;
      const nextRecents = pushRecent(previewRecents, url);

      persistString(PREVIEW_URL_KEY, url);
      persistString(PREVIEW_RECENTS_KEY, JSON.stringify(nextRecents));

      set({
        previewUrl: url,
        previewHistory: nextHistory,
        previewHistoryIndex: nextIndex,
        previewRecents: nextRecents,
        previewOpen: true,
      });
    },
    goPreviewBack: () => {
      const { previewHistory, previewHistoryIndex } = get();
      if (previewHistoryIndex <= 0) return;
      const nextIndex = previewHistoryIndex - 1;
      const previewUrl = previewHistory[nextIndex] || "";
      persistString(PREVIEW_URL_KEY, previewUrl);
      set({ previewHistoryIndex: nextIndex, previewUrl });
    },
    goPreviewForward: () => {
      const { previewHistory, previewHistoryIndex } = get();
      if (previewHistoryIndex < 0 || previewHistoryIndex >= previewHistory.length - 1) return;
      const nextIndex = previewHistoryIndex + 1;
      const previewUrl = previewHistory[nextIndex] || "";
      persistString(PREVIEW_URL_KEY, previewUrl);
      set({ previewHistoryIndex: nextIndex, previewUrl });
    },
    reloadPreview: () => set((state) => ({ previewReloadToken: state.previewReloadToken + 1 })),
    openPreview: (mode) => {
      const previewMode = mode || get().previewMode;
      persistString(PREVIEW_MODE_KEY, previewMode);
      if (previewMode === "dock") {
        set({
          previewOpen: true,
          previewMode,
          rightDockOpen: true,
          rightPanelTab: "preview",
        });
        return;
      }
      const patch: Partial<UiStore> = { previewOpen: true, previewMode };
      if (get().rightPanelTab === "preview") {
        patch.rightPanelTab = "terminal";
      }
      set(patch);
    },
    closePreview: () => {
      const { rightPanelTab } = get();
      if (rightPanelTab === "preview") {
        set({ previewOpen: false, rightDockOpen: false, rightPanelTab: "terminal" });
        return;
      }
      set({ previewOpen: false });
    },
    togglePreview: () => {
      if (get().previewOpen) {
        get().closePreview();
        return;
      }
      get().openPreview();
    },
  };
});

export const PREVIEW_HEIGHT_BOUNDS = {
  min: MIN_PREVIEW_HEIGHT,
  max: MAX_PREVIEW_HEIGHT,
  default: DEFAULT_PREVIEW_HEIGHT,
} as const;
