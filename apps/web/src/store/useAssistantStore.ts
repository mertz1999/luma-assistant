import { create } from "zustand";
import type { BootstrapPayload, ThreadRecord, TimelineEntry } from "@/types";
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
  account: unknown;
  threads: ThreadRecord[];
  archivedThreads: ThreadRecord[];
  models: unknown[];
  mcpServers: Record<string, unknown>[];
  activeThreadId: string | null;
  activeThreadArchived: boolean;
  activeTurnId: string | null;
  showArchived: boolean;
  timelines: Record<string, TimelineEntry[]>;
  setBootstrap: (payload: BootstrapPayload) => void;
  setAccount: (account: unknown) => void;
  setMcpServers: (servers: Record<string, unknown>[]) => void;
  setShowArchived: (show: boolean) => void;
  setActiveThread: (threadId: string | null, archived: boolean) => void;
  setActiveTurnId: (turnId: string | null) => void;
  upsertThread: (thread: ThreadRecord, archived: boolean) => void;
  moveThreadToArchive: (threadId: string) => void;
  moveThreadToActive: (threadId: string) => void;
  setThreadTimeline: (threadId: string, entries: TimelineEntry[]) => void;
  appendTimelineEntry: (threadId: string, entry: TimelineEntry) => void;
  upsertTimelineEntry: (threadId: string, key: string, updater: (existing?: TimelineEntry) => TimelineEntry) => void;
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

export const useAssistantStore = create<AssistantState>((set) => ({
  bridgeState: null,
  defaults: null,
  account: null,
  threads: [],
  archivedThreads: [],
  models: [],
  mcpServers: [],
  activeThreadId: null,
  activeThreadArchived: false,
  activeTurnId: null,
  showArchived: false,
  timelines: {},

  setBootstrap: (payload) =>
    set(() => ({
      bridgeState: payload.bridgeState || null,
      defaults: payload.defaults || null,
      account: payload.data?.account?.account || null,
      threads: payload.data?.threads?.data || [],
      archivedThreads: payload.data?.archivedThreads?.data || [],
      models: payload.data?.models?.data || [],
      mcpServers: normalizeMcp(payload.data?.mcpServers),
    })),

  setAccount: (account) => set(() => ({ account })),

  setMcpServers: (servers) => set(() => ({ mcpServers: servers })),

  setShowArchived: (showArchived) => set(() => ({ showArchived })),

  setActiveThread: (activeThreadId, activeThreadArchived) => set(() => ({ activeThreadId, activeThreadArchived })),

  setActiveTurnId: (activeTurnId) => set(() => ({ activeTurnId })),

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
      return { [key]: list } as Pick<AssistantState, "threads" | "archivedThreads">;
    }),

  moveThreadToArchive: (threadId) =>
    set((state) => {
      const activeList = [...state.threads];
      const archivedList = [...state.archivedThreads];
      const index = activeList.findIndex((thread) => thread.id === threadId);
      if (index === -1) return state;

      const [thread] = activeList.splice(index, 1);
      archivedList.unshift(thread);

      return {
        threads: activeList,
        archivedThreads: archivedList,
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

      return {
        threads: activeList,
        archivedThreads: archivedList,
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

  clearSession: () =>
    set(() => ({
      bridgeState: null,
      defaults: null,
      account: null,
      threads: [],
      archivedThreads: [],
      models: [],
      mcpServers: [],
      activeThreadId: null,
      activeThreadArchived: false,
      activeTurnId: null,
      showArchived: false,
      timelines: {},
    })),
}));
