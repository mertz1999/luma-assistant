import { type AllowedRpcMethod } from "@assistant/shared";
import type { BootstrapPayload } from "@/types";

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
};

type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<ApiSuccess<T>> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    ...init,
  });

  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

  if (!response.ok || !payload || payload.ok === false) {
    const message = payload && "error" in payload && payload.error?.message
      ? payload.error.message
      : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

export async function login(password: string): Promise<void> {
  await apiRequest("/api/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function logout(): Promise<void> {
  await apiRequest("/api/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function bootstrap(): Promise<BootstrapPayload> {
  const response = await fetch("/api/bootstrap", {
    credentials: "include",
    method: "GET",
  });

  const payload = (await response.json().catch(() => null)) as
    | (BootstrapPayload & { ok?: boolean; error?: { message?: string } })
    | null;

  if (!response.ok || !payload || payload.ok === false) {
    const message = payload?.error?.message || `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

export async function rpc<T = unknown>(method: AllowedRpcMethod, params: Record<string, unknown> = {}): Promise<T> {
  const response = await apiRequest<T>("/api/rpc", {
    method: "POST",
    body: JSON.stringify({ method, params }),
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
