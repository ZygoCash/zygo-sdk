import { ResultAsync } from "neverthrow";
import { ZygoError } from "./index.js";

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

const MAX_ATTEMPTS = 4;

function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter && retryAfter > 0) return retryAfter * 1000;
  return Math.min(400 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5);
}

/** One request with retry on 429/5xx/network errors, honoring Retry-After. */
export function request<T>(
  cfg: HttpConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): ResultAsync<T, ZygoError> {
  return ResultAsync.fromPromise(
    (async (): Promise<T> => {
      let lastErr: ZygoError | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const res = await attemptOnce<T>(cfg, method, path, body);
        if (res.ok) return res.value as T;
        lastErr = res.error;
        if (!lastErr!.retryable) break;
        await new Promise((r) => setTimeout(r, backoffMs(attempt, res.retryAfter)));
      }
      throw lastErr ?? new ZygoError("request failed", "UNKNOWN", 0, true);
    })(),
    (e) => (e instanceof ZygoError ? e : new ZygoError(String(e), "UNKNOWN", 0, true))
  );
}

interface Attempt<T> {
  ok: boolean;
  value?: T;
  error?: ZygoError;
  retryAfter?: number;
}

async function attemptOnce<T>(
  cfg: HttpConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<Attempt<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.baseUrl + path, {
      method,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": cfg.apiKey,
        ...(method !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, value: data as T };
    const retryable = res.status === 429 || res.status >= 500;
    const retryAfter = Number(res.headers.get("Retry-After") ?? 0) || undefined;
    return {
      ok: false,
      retryAfter,
      error: new ZygoError(
        (data.message as string) ?? `request failed (${res.status})`,
        (data.code as string) ?? "HTTP_" + res.status,
        res.status,
        retryable
      ),
    };
  } catch (e) {
    return {
      ok: false,
      error: new ZygoError(
        e instanceof Error ? e.message : String(e),
        "NETWORK",
        0,
        true
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}
