export type DesktopState = {
  mode: "local" | "cloud";
  cloudUrl: string;
  folders: string[];
  engine: {
    status: "stopped" | "starting" | "ready" | "error";
    error: string | null;
    codexPath: string;
    authAvailable: boolean;
    claudePath?: string;
    cursorPath?: string;
    claudeHome?: string;
    cursorHome?: string;
    cursorData?: string;
  };
  version: string;
  remote: DesktopRemoteState;
};

export type DesktopRemoteState = {
  paired: boolean;
  status: "unpaired" | "unavailable" | "connecting" | "online" | "offline" | "revoked";
  cloudUrl: string;
  folders: string[];
  canControl: boolean;
};

export type DesktopBridge = {
  isLocal: boolean;
  getState(): Promise<DesktopState>;
  localAuth(): Promise<{ token: string; expiresAt: number } | null>;
  switchConnection(mode: "local" | "cloud", cloudUrl?: string): Promise<boolean>;
  chooseFolder(): Promise<string | null>;
  removeFolder(folder: string): Promise<DesktopState>;
  retryLocal(): Promise<DesktopState>;
  pairRemote(input: { cloudUrl: string; code: string; name: string; folders: string[] }): Promise<DesktopRemoteState>;
  configureRemote(input: { folders: string[]; canControl: boolean }): Promise<DesktopRemoteState>;
  unpairRemote(): Promise<DesktopRemoteState>;
};

declare global {
  interface Window { lumaDesktop?: DesktopBridge; }
}

export const isDesktopLocal = Boolean(window.lumaDesktop?.isLocal);
