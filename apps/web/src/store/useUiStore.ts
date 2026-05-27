import { create } from "zustand";

type ToolTab = "approvals" | "diff" | "files";
type RightPanelTab = "context" | "tools" | "agents";

type UiStore = {
  selectedRunId: string | null;
  toolTab: ToolTab;
  rightPanelTab: RightPanelTab;
  mobileThreadsOpen: boolean;
  mobileContextOpen: boolean;
  theme: "light" | "dark";
  setSelectedRunId: (runId: string | null) => void;
  setToolTab: (tab: ToolTab) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setMobileThreadsOpen: (open: boolean) => void;
  setMobileContextOpen: (open: boolean) => void;
  toggleTheme: () => void;
};

function getInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem("luma_assistant_theme") || window.localStorage.getItem("agentic_cli_theme");
  if (saved === "dark" || saved === "light") return saved;
  return "light";
}

export const useUiStore = create<UiStore>((set, get) => ({
  selectedRunId: null,
  toolTab: "approvals",
  rightPanelTab: "context",
  mobileThreadsOpen: false,
  mobileContextOpen: false,
  theme: getInitialTheme(),
  setSelectedRunId: (selectedRunId) => set({ selectedRunId }),
  setToolTab: (toolTab) => set({ toolTab }),
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
  setMobileThreadsOpen: (mobileThreadsOpen) => set({ mobileThreadsOpen }),
  setMobileContextOpen: (mobileContextOpen) => set({ mobileContextOpen }),
  toggleTheme: () => {
    const next = get().theme === "light" ? "dark" : "light";
    if (typeof window !== "undefined") {
      window.localStorage.setItem("luma_assistant_theme", next);
      window.localStorage.removeItem("agentic_cli_theme");
      document.documentElement.setAttribute("data-theme", next);
    }
    set({ theme: next });
  },
}));
