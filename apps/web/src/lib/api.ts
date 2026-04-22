import { type AllowedRpcMethod, type BootstrapCapabilities, type GuardRequirement } from "@assistant/shared";
import type { BootstrapPayload, PersistedUiState } from "@/types";

export type ApiError = {
  message: string;
  code?: number | null;
  data?: unknown;
};

type ApiSuccess<T> = {
  ok: true;
  result?: T;
  data?: T;
  sessionToken?: string;
};

type ApiFailure = {
  ok: false;
  error: ApiError;
  guard?: GuardRequirement;
};

type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

const SESSION_TOKEN_KEY = "assistant_session_token";
const API_DEBUG = String(import.meta.env.VITE_DEBUG_LOGS ?? "false").toLowerCase() === "true";

function apiDebug(event: string, payload: Record<string, unknown> = {}): void {
  if (!API_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`[api-debug] ${event}`, payload);
}

function readStoredSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(SESSION_TOKEN_KEY);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

let sessionToken: string | null = readStoredSessionToken();

function persistSessionToken(token: string | null): void {
  sessionToken = token;
  if (typeof window === "undefined") return;
  try {
    if (token) {
      window.localStorage.setItem(SESSION_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(SESSION_TOKEN_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export class ApiRequestError extends Error {
  code: number | null;
  data: unknown;
  guard?: GuardRequirement;

  constructor(message: string, input: { code?: number | null; data?: unknown; guard?: GuardRequirement } = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.code = input.code ?? null;
    this.data = input.data;
    this.guard = input.guard;
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<ApiSuccess<T>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers || {}) as Record<string, string>),
  };

  if (sessionToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${sessionToken}`;
  }

  const response = await fetch(path, {
    credentials: "include",
    headers,
    ...init,
  });
  apiDebug("request", {
    path,
    method: init.method || "GET",
    status: response.status,
  });

  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

  if (!response.ok || !payload || payload.ok === false) {
    const message = payload && "error" in payload && payload.error?.message
      ? payload.error.message
      : `Request failed (${response.status})`;

    const guard = payload && "guard" in payload ? payload.guard : undefined;
    const code = payload && "error" in payload ? payload.error?.code ?? response.status : response.status;
    const data = payload && "error" in payload ? payload.error?.data : null;

    if (response.status === 401) {
      persistSessionToken(null);
    }
    apiDebug("request.error", {
      path,
      method: init.method || "GET",
      status: response.status,
      message,
      hasGuard: Boolean(guard),
    });
    throw new ApiRequestError(message, { code, data, guard });
  }

  if (payload.sessionToken && typeof payload.sessionToken === "string") {
    persistSessionToken(payload.sessionToken);
  }

  return payload;
}

export async function login(password: string): Promise<void> {
  await apiRequest("/api/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function checkSession(): Promise<boolean> {
  const response = await apiRequest<{ authenticated?: boolean }>("/api/session", {
    method: "GET",
  });
  const payload = (response.result || response.data) as { authenticated?: boolean } | undefined;
  return Boolean(payload?.authenticated);
}

export async function logout(): Promise<void> {
  await apiRequest("/api/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });
  persistSessionToken(null);
}

export async function bootstrap(): Promise<BootstrapPayload> {
  const response = await apiRequest<BootstrapPayload>("/api/bootstrap", {
    method: "GET",
  });

  // /api/bootstrap returns payload fields at the top level (not nested under result/data).
  const topLevel = response as unknown as BootstrapPayload;
  if (topLevel && (topLevel.data || topLevel.defaults || topLevel.bridgeState)) {
    return topLevel;
  }

  return (response.result || response.data) as BootstrapPayload;
}

export async function rpc<T = unknown>(
  method: AllowedRpcMethod,
  params: Record<string, unknown> = {},
  guard?: {
    acceptRisk?: boolean;
    acceptForSession?: boolean;
    reauthPassword?: string;
  },
): Promise<T> {
  const response = await apiRequest<T>("/api/rpc", {
    method: "POST",
    body: JSON.stringify({ method, params, ...(guard ? { guard } : {}) }),
  });

  return (response.result || response.data) as T;
}

export async function respondToServerRequest(input: {
  requestId: string | number;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}): Promise<void> {
  await apiRequest("/api/server-request/respond", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function readCapabilities(): Promise<BootstrapCapabilities> {
  const response = await apiRequest<BootstrapCapabilities>("/api/capabilities", {
    method: "GET",
  });
  return (response.result || response.data) as BootstrapCapabilities;
}

export async function readUiState(): Promise<PersistedUiState> {
  const response = await apiRequest<PersistedUiState>("/api/ui-state", {
    method: "GET",
  });
  return (response.result || response.data) as PersistedUiState;
}

export async function patchUiState(input: Partial<PersistedUiState>): Promise<PersistedUiState> {
  const response = await apiRequest<PersistedUiState>("/api/ui-state", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (response.result || response.data) as PersistedUiState;
}
