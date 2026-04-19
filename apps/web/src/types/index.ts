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
};

export type PendingApproval = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
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
    threads?: { data?: ThreadRecord[] };
    archivedThreads?: { data?: ThreadRecord[] };
    models?: { data?: unknown[] };
    mcpServers?: { data?: unknown[]; servers?: unknown[] };
  };
};
