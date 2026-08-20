import { createHmac, timingSafeEqual } from "node:crypto";
import { Result, ok, err } from "neverthrow";
import { ZygoError } from "./index.js";

export interface WebhookEvent {
  event_type: string;
  occurred_at: string;
  [key: string]: unknown;
}

/**
 * Verify a Zygo webhook delivery. `rawBody` must be the unparsed request
 * body string; `signatureHeader` is the X-Zygo-Signature header value;
 * `secret` is the whsec_… shown once when the endpoint was created.
 */
export function verify(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Result<WebhookEvent, ZygoError> {
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return err(
      new ZygoError("webhook signature mismatch", "WEBHOOK_AUTH_FAILED", 401, false)
    );
  }
  try {
    return ok(JSON.parse(rawBody) as WebhookEvent);
  } catch {
    return err(new ZygoError("webhook body is not valid JSON", "BAD_PAYLOAD", 400, false));
  }
}
