import { ResultAsync } from "neverthrow";
import { ZygoError } from "./index.js";
import { HttpConfig, request } from "./http.js";
import { ResolveResult } from "./types.js";

export function createMerchants(cfg: HttpConfig) {
  return {
    /** Resolve a raw UPI QR payload into a Zygo merchant destination. */
    resolveQr(rawQrPayload: string): ResultAsync<ResolveResult, ZygoError> {
      return request(cfg, "POST", "/v1/payment-destinations/resolve", {
        raw_text: rawQrPayload,
        input_method: "manual",
      });
    },
  };
}
