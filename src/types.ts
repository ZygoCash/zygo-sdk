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

export interface Quote {
  quote_id: string;
  public_id: string;
  fiat_currency: string;
  fiat_amount_minor: number;
  asset_id: string;
  stablecoin_amount_base: number;
  lp_spread_base: number;
  platform_fee_base: number;
  network_fee_estimate_base: number;
  total_base: number;
  reference_rate_scaled: number;
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
