import fs from "node:fs";
import path from "node:path";

type UiState = {
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

const defaultUiState: UiState = {
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

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as T;
    return parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

export class UiStateStore {
  private filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "data", "ui-state.json");
    ensureDir(path.dirname(this.filePath));

    if (!fs.existsSync(this.filePath)) {
      writeJsonAtomic(this.filePath, defaultUiState);
    }
  }

  read(): UiState {
    const incoming = readJsonSafe<Partial<UiState>>(this.filePath, defaultUiState);

    return {
      ...defaultUiState,
      ...incoming,
      panelLayout: {
        ...defaultUiState.panelLayout,
        ...(incoming.panelLayout || {}),
      },
      filters: {
        ...defaultUiState.filters,
        ...(incoming.filters || {}),
      },
      composer: {
        ...defaultUiState.composer,
        ...(incoming.composer || {}),
        draftByThread: {
          ...defaultUiState.composer.draftByThread,
          ...((incoming.composer || {}).draftByThread || {}),
        },
      },
      pinnedThreadIds: Array.isArray(incoming.pinnedThreadIds)
        ? incoming.pinnedThreadIds.filter((item): item is string => typeof item === "string")
        : [],
      lastActiveThreadId: typeof incoming.lastActiveThreadId === "string" ? incoming.lastActiveThreadId : null,
    };
  }

  patch(patchValue: Partial<UiState>): UiState {
    const current = this.read();
    const next: UiState = {
      ...current,
      ...patchValue,
      panelLayout: {
        ...current.panelLayout,
        ...(patchValue.panelLayout || {}),
      },
      filters: {
        ...current.filters,
        ...(patchValue.filters || {}),
      },
      composer: {
        ...current.composer,
        ...(patchValue.composer || {}),
        draftByThread: {
          ...current.composer.draftByThread,
          ...((patchValue.composer || {}).draftByThread || {}),
        },
      },
    };

    writeJsonAtomic(this.filePath, next);
    return next;
  }
}

export class AuditLogger {
  private dir: string;
  private maxBytes: number;
  private maxFiles: number;

  constructor(rootDir: string, options: { maxBytes?: number; maxFiles?: number } = {}) {
    this.dir = path.join(rootDir, "data");
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 7;
    ensureDir(this.dir);
  }

  log(event: string, payload: Record<string, unknown> = {}): void {
    try {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const filePath = this.resolveFilePath(date);
      const row = {
        at: now.toISOString(),
        event,
        ...payload,
      };

      fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
      this.rotateIfNeeded(filePath, date);
      this.cleanupOldFiles();
    } catch {
      // Never crash request handling on audit failures.
    }
  }

  private resolveFilePath(date: string): string {
    return path.join(this.dir, `audit-log-${date}.jsonl`);
  }

  private rotateIfNeeded(filePath: string, date: string): void {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size <= this.maxBytes) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotated = path.join(this.dir, `audit-log-${date}-${stamp}.jsonl`);
    fs.renameSync(filePath, rotated);
    fs.writeFileSync(filePath, "", "utf8");
  }

  private cleanupOldFiles(): void {
    const files = fs
      .readdirSync(this.dir)
      .filter((name) => name.startsWith("audit-log-") && name.endsWith(".jsonl"))
      .map((name) => ({
        name,
        path: path.join(this.dir, name),
        mtime: fs.statSync(path.join(this.dir, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length <= this.maxFiles) return;

    for (const entry of files.slice(this.maxFiles)) {
      fs.unlinkSync(entry.path);
    }
  }
}

export type PersistedUiState = UiState;

export type MessageQueueStatus = "pending" | "processing" | "completed" | "failed";

export type PersistedQueuedMessage = {
  id: string;
  threadId: string;
  text: string;
  collaborationMode?: Record<string, unknown> | null;
  status: MessageQueueStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export class MessageQueueStore {
  private filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "data", "message-queue.json");
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) {
      writeJsonAtomic(this.filePath, { items: [] });
    }
  }

  read(): PersistedQueuedMessage[] {
    const parsed = readJsonSafe<{ items?: unknown }>(this.filePath, { items: [] });
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items: PersistedQueuedMessage[] = [];

    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;

      if (typeof row.id !== "string" || row.id.trim().length === 0) continue;
      if (typeof row.threadId !== "string" || row.threadId.trim().length === 0) continue;
      if (typeof row.text !== "string") continue;

      const status: MessageQueueStatus =
        row.status === "processing" || row.status === "completed" || row.status === "failed" ? row.status : "pending";

      items.push({
        id: row.id,
        threadId: row.threadId,
        text: row.text,
        collaborationMode:
          row.collaborationMode && typeof row.collaborationMode === "object" && !Array.isArray(row.collaborationMode)
            ? (row.collaborationMode as Record<string, unknown>)
            : null,
        status,
        attempts: typeof row.attempts === "number" ? row.attempts : 0,
        lastError: typeof row.lastError === "string" ? row.lastError : null,
        nextAttemptAt: typeof row.nextAttemptAt === "number" ? row.nextAttemptAt : null,
        createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now(),
        completedAt: typeof row.completedAt === "number" ? row.completedAt : null,
      });
    }

    return items;
  }

  write(items: PersistedQueuedMessage[]): void {
    writeJsonAtomic(this.filePath, { items });
  }
}
