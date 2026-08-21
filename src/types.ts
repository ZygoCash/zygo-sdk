// Response types mirror the Zygo API (backend openapi.yaml). Times are
// RFC3339 strings; token amounts are integer base units.

export interface ResolveResult {
  merchant_payment_destination_id: string;
  merchant_name: string;
  payee_identifier: string;
  rail_code: string;
  suggested_amount_minor?: number;
  merchant_category?: string;
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
  reference_rate_scaled?: number;
  expires_at: string;
}

export interface Order {
  order_id: string;
  public_id: string;
  current_state: string;
  fiat_currency: string;
  fiat_amount_minor: number;
  stablecoin_amount_base: number;
  refund_tx_hash?: string;
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
  vault_address: string;
  amount_base: number;
  memo: string;
  /** "program" (escrow PDA) or "vault_transfer" (memo transfer fallback). */
  path: string;
  program_id?: string;
  escrow_pda?: string;
  /** hex, 32 bytes — present on the program path. */
  order_hash?: string;
}
