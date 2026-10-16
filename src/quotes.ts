import { ResultAsync } from "neverthrow";
import { ZygoError } from "./index.js";
import { HttpConfig, request } from "./http.js";
import { Asset, Quote } from "./types.js";

export function createQuotes(cfg: HttpConfig) {
  return {
    /** Assets enabled on the active chain (public config, still key-authed). */
    listAssets(): ResultAsync<Asset[], ZygoError> {
      return request(cfg, "GET", "/v1/config/assets");
    },

    get(quoteId: string): ResultAsync<Quote, ZygoError> {
      return request(cfg, "GET", `/v1/quotes/${quoteId}`);
    },

    /**
     * Requires the quotes:write scope. `fiatAmountMinor` is in the
     * destination currency's minor units (see config.paymentRails()).
     * Errors: ASSET_NOT_SUPPORTED (422, asset not on this network),
     * RATE_UNAVAILABLE (503, retried), PRICING_INVALID (503, not retried).
     */
    create(params: {
      merchantPaymentDestinationId: string;
      assetId: string;
      fiatAmountMinor: number;
    }): ResultAsync<Quote, ZygoError> {
      return request(cfg, "POST", "/v1/quotes", {
        merchant_payment_destination_id: params.merchantPaymentDestinationId,
        asset_id: params.assetId,
        fiat_amount_minor: params.fiatAmountMinor,
      });
    },
  };
}
