import { ResultAsync } from "neverthrow";
import { ZygoError } from "./index.js";
import { HttpConfig, request } from "./http.js";
import { Capabilities, CurrentRate, PaymentRail } from "./types.js";

export function createConfig(cfg: HttpConfig) {
  return {
    /** Networks, assets, countries and payment methods this deployment serves. */
    capabilities(): ResultAsync<Capabilities, ZygoError> {
      return request(cfg, "GET", "/v1/capabilities");
    },

    /**
     * Enabled rails per corridor, with each currency's minor units — use them
     * to convert a display amount into fiat_amount_minor.
     */
    paymentRails(): ResultAsync<PaymentRail[], ZygoError> {
      return request(cfg, "GET", "/v1/config/payment-rails");
    },

    /**
     * Live rate for the default corridor, for indicative estimates only — the
     * quote's rate_scaled is authoritative. Errors with RATE_UNAVAILABLE (503)
     * when no live source is usable.
     */
    currentRate(): ResultAsync<CurrentRate, ZygoError> {
      return request(cfg, "GET", "/v1/rates/current");
    },
  };
}
