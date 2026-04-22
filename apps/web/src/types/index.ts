import type { BootstrapCapabilities } from "@assistant/shared";

export type ThreadRecord = {
  id: string;
  name?: string | null;
  preview?: string;
  status?: {
    type?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type TimelineEntry = {
  key: string;
  role: "user" | "agent" | "tool" | "plan";
  title?: string;
  text: string;
  pending?: boolean;
  meta?: {
    type?: string;
    status?: string | null;
    command?: string | null;
    path?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    durationMs?: number | null;
    errorMessage?: string | null;
    grantRoot?: string | null;
    fileChanges?: Array<{
      path: string;
      kind: string;
      diff: string;
      added: number;
      removed: number;
    }>;
  };
};

export type PendingApproval = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
};

export type PersistedUiState = {
  lastActiveThreadId: string | null;
  pinnedThreadIds: string[];
  panelLayout: {
    contextTab: "context" | "ops" | "admin";
  };
  filters: {
    showArchived: boolean;
  };
  composer: {
    draftByThread: Record<string, string>;
  };
};

export type BootstrapPayload = {
  bridgeState?: {
    running: boolean;
    initialized: boolean;
    lastStatus: Record<string, unknown> | null;
  };
  defaults?: {
    cwd: string;
    model: string;
    approvalPolicy: string;
    sandboxType: string;
  };
  data?: {
    account?: { account?: unknown };
    rateLimits?: Record<string, unknown>;
    threads?: { data?: ThreadRecord[] };
    archivedThreads?: { data?: ThreadRecord[] };
    loadedThreads?: { data?: string[]; threadIds?: string[] };
    models?: { data?: unknown[] };
    mcpServers?: { data?: unknown[]; servers?: unknown[] };
    featureFlags?: { data?: unknown[] };
    collaborationModes?: { data?: unknown[] };
    capabilities?: BootstrapCapabilities;
    uiState?: PersistedUiState;
  };
};
