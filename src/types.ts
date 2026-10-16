// Response types mirror the Zygo API (backend openapi.yaml). Times are
// RFC3339 strings; token amounts are integer base units.

export interface ResolveResult {
  destination_id: string;
  merchant_payment_destination_id: string;
  merchant_id: string;
  merchant_public_id: string;
  merchant_name: string;
  claim_status: string;
  rail_code: string;
  rail_category: string;
  country: string;
  currency: string;
  identifier_type: string;
  masked_identifier: string;
  capabilities: string[];
  merchant_newly_created: boolean;
  suggested_amount_minor?: number;
  merchant_category?: string;
  payee_identifier?: string;
}

export interface Asset {
  asset_id: string;
  symbol: string;
  name: string;
  decimals: number;
  chain_name: string;
  chain_namespace: string;
  chain_reference: string;
  /** Token mint/contract address for the asset's chain. */
  contract_or_mint: string;
}

/**
 * The payer-facing quote. Fee rule v5 prices everything into one all-in
 * rate: `total_base` is the full amount the payer deposits, and Zygo's
 * margin is not itemized.
 */
export interface Quote {
  quote_id: string;
  public_id: string;
  fiat_currency: string;
  /** Fiat amount in the currency's minor units (see PaymentRail.minor_units). */
  fiat_amount_minor: number;
  asset_id: string;
  /** Everything the payer deposits, in token base units. */
  total_base: number;
  /** Same as total_base (kept for older integrations). */
  stablecoin_amount_base: number;
  network_fee_estimate_base: number;
  /** All-in rate: 1 token = rate_scaled / 1e6 fiat (major units). */
  rate_scaled: number;
  expires_at: string;
}

export interface Order {
  order_id: string;
  public_id: string;
  quote_id: string;
  user_id: string;
  merchant_id: string;
  fiat_currency: string;
  fiat_amount_minor: number;
  asset_id: string;
  stablecoin_amount_base: number;
  platform_fee_base: number;
  current_state: string;
  /** Set on GET once an on-chain refund was sent. */
  refund_tx_hash?: string;
  /** Rail payment reference (e.g. UPI UTR), revealed once fiat is sent. */
  fiat_reference?: string;
}

export interface OrderSummary {
  order_id: string;
  public_id: string;
  merchant_name: string;
  fiat_currency: string;
  fiat_amount_minor: number;
  stablecoin_amount_base: number;
  current_state: string;
  created_at: string;
  chat_unread_count: number;
}

export interface CancellationResult {
  status: string;
}

export interface ListOrdersOptions {
  status?: "active" | "history";
  sort?: "latest" | "oldest" | "amount_asc" | "amount_desc";
  limit?: number;
  offset?: number;
  wallet?: string;
}

export interface TimelineEvent {
  from_state: string | null;
  to_state: string;
  actor_type: string;
  reason_code: string;
  created_at: string;
}

export interface DepositInstructions {
  escrow_id: string;
  chain: string;
  chain_name: string;
  mint: string;
  /** Active escrow program id for this order's chain (devnet/mainnet). */
  program_id: string;
  /** Escrow PDA derived from the program and order hash. */
  escrow_pda: string;
  /** hex, 32 bytes — SHA-256 of the backend order public id. */
  order_hash: string;
  amount_base: number;
}

/** An enabled payment rail in one corridor (country + fiat currency). */
export interface PaymentRail {
  corridor_id: string;
  code: string;
  display_name: string;
  country: string;
  currency: string;
  /** Decimal places of the fiat currency — fiat_amount_minor uses these. */
  minor_units: number;
  provider: string;
  identifier_types: string[];
  capabilities: Record<string, unknown>;
  limits: Record<string, unknown>;
}

export interface Capabilities {
  networks: string[];
  assets: string[];
  countries: string[];
  payment_methods: string[];
  features: Record<string, boolean>;
}

/**
 * Live USD reference rates (scaled by 1e6) for indicative estimates. The
 * quote's rate_scaled is always authoritative.
 */
export interface CurrentRate {
  /** All-in rate a payer gets right now: 1 USDC = rate fiat. */
  rate: number;
  rate_scaled: number;
  ref_rate: number;
  ref_rate_scaled: number;
  sell_rate: number;
  sell_rate_scaled: number;
  buy_rate: number;
  buy_rate_scaled: number;
  /** "live" or "manual" (admin-pinned rate) */
  mode: string;
  source: string;
  fetched_at: string;
  user_markup_bps: number;
  platform_fee_bps: number;
  small_lp_pct_bps: number;
}
