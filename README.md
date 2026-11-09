# @zygopay/sdk

TypeScript SDK for Zygo — UPI QR payments settled through a non-custodial
Solana escrow. Server-side only: secret API keys must never ship to a
browser or mobile app.

Questions? Ask in [GitHub Discussions](https://github.com/ZygoCash/zygo-sdk/discussions/categories/q-a).

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
// quote.value.total_base — everything the payer deposits (token base units)
// quote.value.rate_scaled — all-in rate: 1 USDC = rate_scaled / 1e6 fiat

// 3. Create the order (idempotent)
const order = await zygo.orders.create({ quoteId: quote.value.quote_id });

// 4. Get on-chain deposit instructions for the account's primary Solana wallet
const deposit = await zygo.payments.depositInstructions(order.value.order_id);
// → deposit.value: { escrow_id, program_id, escrow_pda, order_hash, order_ref,
//                    mint, amount_base, reward_points, gross_base, points_value_base }
// Pay part of the order with Zygo points: depositInstructions(orderId, { points: 50 })

// 5. Wait for settlement (or use a webhook instead)
const done = await zygo.orders.waitFor(order.value.order_id, "completed");
```

## Currencies and rates

`fiatAmountMinor` is in the destination currency's minor units (paise for
INR). Corridors and their `minor_units` come from config:

```ts
const rails = await zygo.config.paymentRails();
// [{ corridor_id, code: "upi", country: "IN", currency: "INR", minor_units: 2, ... }]

// Indicative live rate for estimates (the quote's rate is authoritative):
const rate = await zygo.config.currentRate(); // rate.value.rate = ₹ per USDC, all-in
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
`deposit` in one transaction, built for the v2 escrow program (mainnet
`8mTojgUC3bLUoZm7MhxGsZm34Wr1a1tpRtGDwg6euaUW`; the program id for each
order comes from the deposit instructions).

The escrow is bound to the depositor: `order_hash` is
`sha256("zygo-escrow-v2" ‖ wallet ‖ order_ref)` and the program checks it.
The signer must be the wallet the instructions were prepared for — the API
key owner's primary Solana wallet. `prepare` checks this locally and fails
with `DEPOSITOR_MISMATCH` instead of sending a transaction that would fail.

All methods return `ResultAsync<T, ZygoError>` (neverthrow) — no thrown
exceptions from API failures. Retries on 429/5xx with backoff are built in
(`Retry-After` honored); mutating calls carry an idempotency key that
stays the same across retries of that call.

## Webhooks

Register an endpoint in the app to receive order events; verify signatures:

```ts
import { webhooks } from "@zygopay/sdk/webhooks";

const event = webhooks.verify(rawBody, req.headers["x-zygo-signature"], whsec);
```

## Using Zygo from a mobile app

The SDK runs on your backend, never inside the app. It needs your secret
API key, and anything shipped in an app can be extracted from it. It also
needs Node.js: `createZygo()` refuses to start where a `window` global
exists.

```
Mobile app ──(your own login)──▶ Your backend ──(@zygopay/sdk + API key)──▶ api.zygo.cash
```

1. The app sends the scanned QR text and the amount to your backend.
2. Your backend runs `merchants.resolveQr` → `quotes.create` →
   `orders.create` → `payments.depositInstructions`.
3. The key owner's wallet signs the deposit (`deposit.prepare` +
   `deposit.execute`).
4. Your backend receives order events by webhook (or uses
   `orders.waitFor`) and pushes the status to the app.

Requests made with an API key act as the key owner's account, so every
order is paid from **the key owner's primary Solana wallet** — the escrow
is bound to it on-chain. This fits when your business pays merchants on
behalf of your users. Having each end user pay from their own wallet isn't
supported through API keys today.

If your backend holds that wallet as a keypair, wrap it as a signer. Keep
the secret key in a secrets manager and fund the wallet only with what you
need:

```ts
import { Keypair, Transaction } from "@solana/web3.js";

const kp = Keypair.fromSecretKey(loadSecretKeyFromYourVault());
const signer = {
  publicKey: kp.publicKey,
  signTransaction: async (tx: Transaction) => {
    tx.partialSign(kp);
    return tx;
  },
};
```

## Errors

`ZygoError { code, httpStatus, retryable }`, where `code` is the backend's
error code. Common ones:

| code | status | retried | meaning |
|---|---|---|---|
| `INSUFFICIENT_SCOPE` | 403 | no | key lacks `quotes:write` / `orders:write` |
| `INVITE_REQUIRED` | 403 | no | the key owner's account has no redeemed invite code |
| `ASSET_NOT_SUPPORTED` | 422 | no | asset isn't served on this network (e.g. a devnet mint on live) |
| `QUOTE_UNUSABLE` | 410 | no | quote expired or already used — create a new one |
| `RATE_LIMITED` | 429 | yes | `Retry-After` honored |
| `RATE_UNAVAILABLE` | 503 | yes | no live FX source right now |
| `PRICING_INVALID` | 503 | no | operator pricing misconfiguration |
| `POINTS_UNAVAILABLE` / `POINTS_OVER_LIMIT` / `POINTS_INSUFFICIENT` | 409 | no | points can't cover what was asked — retry without `points` |
| `DEPOSITOR_MISMATCH` | — | no | `deposit.prepare` signer isn't the wallet the order was prepared for |
| `INVALID_DEPOSIT_INSTRUCTIONS` | — | no | deposit instructions incomplete or inconsistent (e.g. no `order_ref`) |

## Environments

`createZygo({ environment: "sandbox" })` targets the devnet-backed sandbox
when available; `"live"` (default) is api.zygo.cash.

## Help and feedback

- **Questions and integration help:** [Discussions → Q&A](https://github.com/ZygoCash/zygo-sdk/discussions/categories/q-a)
- **Ideas and feature requests:** [Discussions → Ideas](https://github.com/ZygoCash/zygo-sdk/discussions/categories/ideas)
- **Bugs:** [open an issue](https://github.com/ZygoCash/zygo-sdk/issues) with the SDK version, the `ZygoError` code and the steps to reproduce

Never paste your API secret, webhook secret or wallet keys into a
discussion or issue.