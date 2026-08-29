import { ResultAsync } from "neverthrow";
import { HttpConfig } from "./http.js";
import { createMerchants } from "./merchants.js";
import { createQuotes } from "./quotes.js";
import { createOrders } from "./orders.js";
import { createPayments } from "./payments.js";
import * as webhooks from "./webhooks.js";

export const VERSION = "0.1.5";

export class ZygoError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ZygoError";
  }
}

export interface ZygoConfig {
  /** `client_id:secret` from the Zygo app (Profile → Developer mode). */
  apiKey: string;
  /** Defaults to https://api.zygo.cash (live). */
  baseUrl?: string;
  /** "live" (default) or "sandbox". */
  environment?: "live" | "sandbox";
  /** Request timeout in ms (default 15s). */
  timeoutMs?: number;
}

export interface Zygo {
  merchants: ReturnType<typeof createMerchants>;
  quotes: ReturnType<typeof createQuotes>;
  orders: ReturnType<typeof createOrders>;
  payments: ReturnType<typeof createPayments>;
  webhooks: typeof webhooks;
}

export function createZygo(config: ZygoConfig): Zygo {
  if (!config.apiKey || !config.apiKey.includes(":")) {
    throw new ZygoError(
      "apiKey must be in the form client_id:secret",
      "INVALID_CONFIG",
      0,
      false
    );
  }
  // Secret keys are server-side credentials; refuse to run in a browser.
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    throw new ZygoError(
      "@zygopay/sdk is server-side only — never ship a secret key to a browser",
      "BROWSER_ENV",
      0,
      false
    );
  }
  const http: HttpConfig = {
    baseUrl: (config.baseUrl ?? "https://api.zygo.cash").replace(/\/$/, ""),
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs ?? 15_000,
  };
  return {
    merchants: createMerchants(http),
    quotes: createQuotes(http),
    orders: createOrders(http),
    payments: createPayments(http),
    webhooks,
  };
}

export type { ResultAsync };
export type * from "./types.js";
export * as webhookUtils from "./webhooks.js";
