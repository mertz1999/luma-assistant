import { create } from "zustand";
import type { BootstrapCapabilities } from "@assistant/shared";
import type { BootstrapPayload, PersistedUiState, ThreadRecord, TimelineEntry } from "@/types";
import { isObject } from "@/lib/utils";

type BridgeState = {
  running: boolean;
  initialized: boolean;
  lastStatus: Record<string, unknown> | null;
};

type Defaults = {
  cwd: string;
  model: string;
  approvalPolicy: string;
  sandboxType: string;
};

type AssistantState = {
  bridgeState: BridgeState | null;
  defaults: Defaults | null;
  capabilities: BootstrapCapabilities | null;
  uiState: PersistedUiState | null;
  account: unknown;
  threads: ThreadRecord[];
  archivedThreads: ThreadRecord[];
  loadedThreadIds: string[];
  models: unknown[];
  mcpServers: Record<string, unknown>[];
  activeThreadId: string | null;
  activeThreadArchived: boolean;
  activeTurnId: string | null;
  showArchived: boolean;
  timelines: Record<string, TimelineEntry[]>;
  setBootstrap: (payload: BootstrapPayload) => void;
  setUiState: (state: PersistedUiState) => void;
  setAccount: (account: unknown) => void;
  setMcpServers: (servers: Record<string, unknown>[]) => void;
  setShowArchived: (show: boolean) => void;
  setActiveThread: (threadId: string | null, archived: boolean) => void;
  setActiveTurnId: (turnId: string | null) => void;
  setLoadedThreadIds: (ids: string[]) => void;
  upsertThread: (thread: ThreadRecord, archived: boolean) => void;
  moveThreadToArchive: (threadId: string) => void;
  moveThreadToActive: (threadId: string) => void;
  setThreadTimeline: (threadId: string, entries: TimelineEntry[]) => void;
  appendTimelineEntry: (threadId: string, entry: TimelineEntry) => void;
  upsertTimelineEntry: (threadId: string, key: string, updater: (existing?: TimelineEntry) => TimelineEntry) => void;
  pinThread: (threadId: string) => void;
  unpinThread: (threadId: string) => void;
  clearSession: () => void;
};

function normalizeMcp(raw: unknown): Record<string, unknown>[] {
  if (!isObject(raw)) return [];

  if (Array.isArray(raw.data)) {
    return raw.data as Record<string, unknown>[];
  }
  if (Array.isArray(raw.servers)) {
    return raw.servers as Record<string, unknown>[];
  }
  return [];
}

function normalizeLoadedThreads(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  if (Array.isArray(raw.data)) return raw.data.filter((id): id is string => typeof id === "string");
  if (Array.isArray(raw.threadIds)) return raw.threadIds.filter((id): id is string => typeof id === "string");
  return [];
}

function sortThreads(threads: ThreadRecord[], pinnedThreadIds: string[]): ThreadRecord[] {
  const pinnedSet = new Set(pinnedThreadIds);
  return [...threads].sort((a, b) => {
    const aPinned = pinnedSet.has(a.id) ? 1 : 0;
    const bPinned = pinnedSet.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;

    const aUpdated = typeof a.updatedAt === "number" ? a.updatedAt : Date.parse(String(a.updatedAt || "")) || 0;
    const bUpdated = typeof b.updatedAt === "number" ? b.updatedAt : Date.parse(String(b.updatedAt || "")) || 0;
    return bUpdated - aUpdated;
  });
}

const defaultUiState: PersistedUiState = {
  lastActiveThreadId: null,
  pinnedThreadIds: [],
  panelLayout: {
    contextTab: "context",
  },
  filters: {
    showArchived: false,
  },
  composer: {
    draftByThread: {},
  },
};

export const useAssistantStore = create<AssistantState>((set) => ({
  bridgeState: null,
  defaults: null,
  capabilities: null,
  uiState: null,
  account: null,
  threads: [],
  archivedThreads: [],
  loadedThreadIds: [],
  models: [],
  mcpServers: [],
  activeThreadId: null,
  activeThreadArchived: false,
  activeTurnId: null,
  showArchived: false,
  timelines: {},

  setBootstrap: (payload) =>
    set(() => {
      const uiState = payload.data?.uiState || defaultUiState;
      const activeThreads = payload.data?.threads?.data || [];
      const archived = payload.data?.archivedThreads?.data || [];

      return {
        bridgeState: payload.bridgeState || null,
        defaults: payload.defaults || null,
        capabilities: payload.data?.capabilities || null,
        uiState,
        account: payload.data?.account?.account || null,
        threads: sortThreads(activeThreads, uiState.pinnedThreadIds),
        archivedThreads: sortThreads(archived, uiState.pinnedThreadIds),
        loadedThreadIds: normalizeLoadedThreads(payload.data?.loadedThreads),
        models: payload.data?.models?.data || [],
        mcpServers: normalizeMcp(payload.data?.mcpServers),
        showArchived: uiState.filters.showArchived,
      };
    }),

  setUiState: (uiState) =>
    set((state) => ({
      uiState,
      showArchived: uiState.filters.showArchived,
      threads: sortThreads(state.threads, uiState.pinnedThreadIds),
      archivedThreads: sortThreads(state.archivedThreads, uiState.pinnedThreadIds),
    })),

  setAccount: (account) => set(() => ({ account })),

  setMcpServers: (servers) => set(() => ({ mcpServers: servers })),

  setShowArchived: (showArchived) =>
    set((state) => ({
      showArchived,
      uiState: {
        ...(state.uiState || defaultUiState),
        filters: {
          ...(state.uiState?.filters || defaultUiState.filters),
          showArchived,
        },
      },
    })),

  setActiveThread: (activeThreadId, activeThreadArchived) =>
    set((state) => ({
      activeThreadId,
      activeThreadArchived,
      uiState: {
        ...(state.uiState || defaultUiState),
        lastActiveThreadId: activeThreadId,
      },
    })),

  setActiveTurnId: (activeTurnId) => set(() => ({ activeTurnId })),

  setLoadedThreadIds: (loadedThreadIds) => set(() => ({ loadedThreadIds })),

  upsertThread: (thread, archived) =>
    set((state) => {
      const key = archived ? "archivedThreads" : "threads";
      const list = [...state[key]];
      const index = list.findIndex((entry) => entry.id === thread.id);
      if (index === -1) {
        list.unshift(thread);
      } else {
        list[index] = {
          ...list[index],
          ...thread,
        };
      }

      const pinned = state.uiState?.pinnedThreadIds || [];
      const sorted = sortThreads(list, pinned);

      return { [key]: sorted } as Pick<AssistantState, "threads" | "archivedThreads">;
    }),

  moveThreadToArchive: (threadId) =>
    set((state) => {
      const activeList = [...state.threads];
      const archivedList = [...state.archivedThreads];
      const index = activeList.findIndex((thread) => thread.id === threadId);
      if (index === -1) return state;

      const [thread] = activeList.splice(index, 1);
      archivedList.unshift(thread);

      const pinned = state.uiState?.pinnedThreadIds || [];

      return {
        threads: sortThreads(activeList, pinned),
        archivedThreads: sortThreads(archivedList, pinned),
      };
    }),

  moveThreadToActive: (threadId) =>
    set((state) => {
      const activeList = [...state.threads];
      const archivedList = [...state.archivedThreads];
      const index = archivedList.findIndex((thread) => thread.id === threadId);
      if (index === -1) return state;

      const [thread] = archivedList.splice(index, 1);
      activeList.unshift(thread);

      const pinned = state.uiState?.pinnedThreadIds || [];

      return {
        threads: sortThreads(activeList, pinned),
        archivedThreads: sortThreads(archivedList, pinned),
      };
    }),

  setThreadTimeline: (threadId, entries) =>
    set((state) => ({
      timelines: {
        ...state.timelines,
        [threadId]: entries,
      },
    })),

  appendTimelineEntry: (threadId, entry) =>
    set((state) => ({
      timelines: {
        ...state.timelines,
        [threadId]: [...(state.timelines[threadId] || []), entry],
      },
    })),

  upsertTimelineEntry: (threadId, key, updater) =>
    set((state) => {
      const timeline = [...(state.timelines[threadId] || [])];
      const index = timeline.findIndex((entry) => entry.key === key);
      if (index === -1) {
        timeline.push(updater(undefined));
      } else {
        timeline[index] = updater(timeline[index]);
      }

      return {
        timelines: {
          ...state.timelines,
          [threadId]: timeline,
        },
      };
    }),

  pinThread: (threadId) =>
    set((state) => {
      const current = state.uiState || defaultUiState;
      const pinned = Array.from(new Set([threadId, ...current.pinnedThreadIds]));
      return {
        uiState: {
          ...current,
          pinnedThreadIds: pinned,
        },
        threads: sortThreads(state.threads, pinned),
        archivedThreads: sortThreads(state.archivedThreads, pinned),
      };
    }),

  unpinThread: (threadId) =>
    set((state) => {
      const current = state.uiState || defaultUiState;
      const pinned = current.pinnedThreadIds.filter((id) => id !== threadId);
      return {
        uiState: {
          ...current,
          pinnedThreadIds: pinned,
        },
        threads: sortThreads(state.threads, pinned),
        archivedThreads: sortThreads(state.archivedThreads, pinned),
      };
    }),

  clearSession: () =>
    set(() => ({
      bridgeState: null,
      defaults: null,
      capabilities: null,
      uiState: null,
      account: null,
      threads: [],
      archivedThreads: [],
      loadedThreadIds: [],
      models: [],
      mcpServers: [],
      activeThreadId: null,
      activeThreadArchived: false,
      activeTurnId: null,
      showArchived: false,
      timelines: {},
    })),
}));
