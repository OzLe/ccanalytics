const BASE_URL = "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Best-effort browser-local IANA timezone for the X-User-Timezone header
 * (ACT-001 / SEM2-293). The server uses this as its highest-precedence
 * source — config.json `display.userTimezone` and the UTC fallback only
 * kick in if this is missing/invalid. Empty in non-browser contexts (tests,
 * SSR), in which case the server falls through to config.json / UTC.
 */
function resolveBrowserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.length > 0 ? tz : "";
  } catch {
    return "";
  }
}

export async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;

  const browserTz = resolveBrowserTimezone();
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (browserTz) baseHeaders["X-User-Timezone"] = browserTz;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...baseHeaders,
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "Unknown error");
    throw new ApiError(response.status, message);
  }

  return response.json() as Promise<T>;
}

export function apiGet<T>(endpoint: string): Promise<T> {
  return apiFetch<T>(endpoint, { method: "GET" });
}

export function apiPost<T>(endpoint: string, body?: unknown): Promise<T> {
  return apiFetch<T>(endpoint, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function apiPut<T>(endpoint: string, body?: unknown): Promise<T> {
  return apiFetch<T>(endpoint, {
    method: "PUT",
    body: body ? JSON.stringify(body) : undefined,
  });
}
