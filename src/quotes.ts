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

    /** Requires the quotes:write scope. */
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
