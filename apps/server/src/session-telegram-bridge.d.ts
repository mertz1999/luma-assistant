import type { RunRecord, SessionListItem } from "@luma/shared";
type LifecycleKind = "started" | "completed" | "failed" | "stopped" | "updated";
export type RunLifecycleEventLike = {
    kind: LifecycleKind;
    run: RunRecord;
    previous?: RunRecord | null;
};
export type SessionTelegramBridgeDeps = {
    rootDir: string;
    resolveSessionId: (run: RunRecord) => string | null;
    getSession: (sessionId: string) => SessionListItem | null;
    listSessions: () => SessionListItem[];
    getLatestResultText: (sessionId: string, runId: string) => {
        text: string;
        kind: "assistant" | "error" | "preview";
    } | null;
    sendToSession: (sessionId: string, text: string) => {
        ok: true;
    } | {
        ok: false;
        error: string;
    };
    rerun: (runId: string) => {
        ok: true;
        runId: string;
    } | {
        ok: false;
        error: string;
    };
    webBaseUrl: string | null;
};
export declare function isSessionTelegramBridgeConfigured(): boolean;
export declare function createSessionTelegramBridge(deps: SessionTelegramBridgeDeps): {
    enabled: boolean;
    start(): void;
    stop(): void;
    onRunLifecycle(event: RunLifecycleEventLike): void;
};
export {};
