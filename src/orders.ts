import { ResultAsync } from "neverthrow";
import { ZygoError } from "./index.js";
import { HttpConfig, request } from "./http.js";
import { Order, TimelineEvent } from "./types.js";

const TERMINAL = new Set(["completed", "refunded", "failed", "expired"]);

export function createOrders(cfg: HttpConfig) {
  const self = {
    /** Requires the orders:write scope. */
    create(params: {
      quoteId: string;
      idempotencyKey?: string;
    }): ResultAsync<Order, ZygoError> {
      return request(cfg, "POST", "/v1/orders", {
        quote_id: params.quoteId,
        idempotency_key: params.idempotencyKey ?? crypto.randomUUID(),
      });
    },

    get(orderId: string): ResultAsync<Order, ZygoError> {
      return request(cfg, "GET", `/v1/orders/${orderId}`);
    },

    timeline(orderId: string): ResultAsync<TimelineEvent[], ZygoError> {
      return request(cfg, "GET", `/v1/orders/${orderId}/timeline`);
    },

    /**
     * Poll until the order reaches `targetState` (or a terminal state).
     * Resolves with the order; errors with ORDER_TIMEOUT / ORDER_TERMINAL.
     */
    waitFor(
      orderId: string,
      targetState: string,
      opts: { timeoutMs?: number; intervalMs?: number } = {}
    ): ResultAsync<Order, ZygoError> {
      const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
      const intervalMs = opts.intervalMs ?? 3000;
      return ResultAsync.fromPromise(
        (async (): Promise<Order> => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const res = await self.get(orderId);
            if (res.isErr()) {
              if (!res.error.retryable) throw res.error;
            } else {
              const o = res.value;
              if (o.current_state === targetState) return o;
              if (TERMINAL.has(o.current_state)) {
                throw new ZygoError(
                  `order reached terminal state ${o.current_state} before ${targetState}`,
                  "ORDER_TERMINAL",
                  0,
                  false
                );
              }
            }
            if (Date.now() > deadline) {
              throw new ZygoError(
                `order did not reach ${targetState} within ${timeoutMs}ms`,
                "ORDER_TIMEOUT",
                0,
                false
              );
            }
            await new Promise((r) => setTimeout(r, intervalMs));
          }
        })(),
        (e) => (e instanceof ZygoError ? e : new ZygoError(String(e), "UNKNOWN", 0, false))
      );
    },
  };
  return self;
}
