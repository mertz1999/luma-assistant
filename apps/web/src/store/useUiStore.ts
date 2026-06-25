import { create } from "zustand";

type RightPanelTab = "terminal" | "approvals" | "context";

type UiStore = {
  selectedRunId: string | null;
  rightPanelTab: RightPanelTab;
  rightDockOpen: boolean;
  mobileThreadsOpen: boolean;
  mobileContextOpen: boolean;
  theme: "light" | "dark";
  setSelectedRunId: (runId: string | null) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setRightDockOpen: (open: boolean) => void;
  setMobileThreadsOpen: (open: boolean) => void;
  setMobileContextOpen: (open: boolean) => void;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
};

function getInitialTheme(): "light" | "dark" {
  if (typeof window !== "undefined") {
    window.localStorage.setItem("luma_assistant_theme", "dark");
    window.localStorage.removeItem("agentic_cli_theme");
    document.documentElement.setAttribute("data-theme", "dark");
  }
  return "dark";
}

export const useUiStore = create<UiStore>((set, get) => ({
  selectedRunId: null,
  rightPanelTab: "terminal",
  rightDockOpen: true,
  mobileThreadsOpen: false,
  mobileContextOpen: false,
  theme: getInitialTheme(),
  setSelectedRunId: (selectedRunId) => set({ selectedRunId }),
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab, rightDockOpen: true }),
  setRightDockOpen: (rightDockOpen) => set({ rightDockOpen }),
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
}));
