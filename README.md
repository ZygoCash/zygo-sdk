# @zygopay/sdk

TypeScript SDK for Zygo — UPI QR payments settled through a non-custodial
Solana escrow. Server-side only: secret API keys must never ship to a
browser or mobile app.

## Get an API key

In the Zygo app: Profile → Developer mode → Create API key. The full
`client_id:secret` is shown **once** — store it in your secrets manager.

## Install

```sh
npm install @zygopay/sdk
```

## Quickstart

```ts
import { createZygo } from "@zygopay/sdk";

const zygo = createZygo({ apiKey: process.env.ZYGO_API_KEY! });

// 1. Resolve a UPI QR payload
const merchant = await zygo.merchants.resolveQr(rawQrText);
if (merchant.isErr()) throw merchant.error;

// 2. Quote (USDC on Solana)
const assets = await zygo.quotes.listAssets();
const usdc = assets.value.find(
  (a) => a.symbol === "USDC" && a.chain_namespace === "solana"
)!;
const quote = await zygo.quotes.create({
  merchantPaymentDestinationId: merchant.value.merchant_payment_destination_id,
  assetId: usdc.asset_id,
  fiatAmountMinor: 500_00, // ₹500.00
});
if (quote.isErr()) throw quote.error;

// 3. Create the order (idempotent)
const order = await zygo.orders.create({ quoteId: quote.value.quote_id });

// 4. Get on-chain deposit instructions for the payer's wallet
const deposit = await zygo.payments.depositInstructions(order.value.order_id);
// → deposit.value: { escrow_id, program_id, escrow_pda, order_hash, mint, amount_base }

// 5. Wait for settlement (or use a webhook instead)
const done = await zygo.orders.waitFor(order.value.order_id, "completed");
```

## Deposits (prepare / execute)

The payer's wallet always signs — the SDK never holds keys. Solana packages
are optional peer deps, only needed when you use `deposit`:

```sh
npm install @solana/web3.js @solana/spl-token @coral-xyz/anchor
```

```ts
import { Connection } from "@solana/web3.js";

const connection = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const signer = myWallet; // { publicKey, signTransaction, ... } — wallet adapter / AppKit / keypair

// prepare → inspect or simulate the unsigned tx, then execute:
const prepared = await zygo.payments.deposit.prepare(deposit.value, { connection, signer });
if (prepared.isErr()) throw prepared.error;

const sig = await zygo.payments.deposit.execute(prepared.value, signer);
// sig.value = confirmed transaction signature
```

The deposit is the escrow program path only: `initialize_escrow` +
`deposit` in one transaction.

All methods return `ResultAsync<T, ZygoError>` (neverthrow) — no thrown
exceptions from API failures. Retries on 429/5xx with backoff are built in
(`Retry-After` honored); mutating calls carry idempotency keys
automatically.

## Webhooks

Register an endpoint in the app to receive order events; verify signatures:

```ts
import { webhooks } from "@zygopay/sdk/webhooks";

const event = webhooks.verify(rawBody, req.headers["x-zygo-signature"], whsec);
```

## Errors

`ZygoError { code, httpStatus, retryable }` — e.g. `INSUFFICIENT_SCOPE`
(403, not retryable), `RATE_LIMITED` (429, retried automatically).

## Environments

`createZygo({ environment: "sandbox" })` targets the devnet-backed sandbox
when available; `"live"` (default) is api.zygo.cash.
