// Live smoke test: full SDK flow against a running backend.
//   1. wallet-auth as the platform keypair (same challenge/verify as the app)
//   2. create a scoped API key through POST /v1/api-clients (the dev-mode path)
//   3. drive the SDK: resolveQr → assets → quote → order → deposit instructions
//   4. revoke the key
// No on-chain deposit is executed (no funds move).
//
// Usage: node scripts/live-smoke.mjs [keypair.json] [api base url]
import { createZygo } from "../dist/index.js";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import fs from "node:fs";

const API = process.argv[3] ?? "http://localhost:8080";
const keypairPath =
  process.argv[2] ??
  new URL("../../zygo/.platform-keypair.json", import.meta.url).pathname;

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")))
);
const address = kp.publicKey.toBase58();
const b64 = (b) => Buffer.from(b).toString("base64");

let failures = 0;
const step = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

// --- 1. wallet auth (app parity) ---
const ch = await fetch(`${API}/v1/auth/challenge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chain_namespace: "solana", address }),
}).then((r) => r.json());
const sig = nacl.sign.detached(new TextEncoder().encode(ch.message), kp.secretKey);
const ver = await fetch(`${API}/v1/auth/wallet/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chain_namespace: "solana",
    address,
    nonce: ch.nonce,
    signature: b64(sig),
  }),
}).then((r) => r.json());
step(!!ver.token, "wallet challenge/verify");

// --- 2. create scoped API key (the dev-mode path) ---
const created = await fetch(`${API}/v1/api-clients`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ver.token}`,
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({
    name: "sdk-live-smoke",
    scopes: ["read", "quotes:write", "orders:write"],
  }),
}).then((r) => r.json());
step(!!created.secret, "API key created", created.client?.client_id);

const apiKey = `${created.client.client_id}:${created.secret}`;
const zygo = createZygo({ apiKey, baseUrl: API });

// --- 3. SDK flow ---
const merchant = await zygo.merchants.resolveQr(
  "upi://pay?pa=sdk-smoke@upi&pn=SDK Smoke Test&cu=INR"
);
step(merchant.isOk(), "merchants.resolveQr", merchant.isOk() ? merchant.value.merchant_payment_destination_id : merchant.error.message);

const assets = await zygo.quotes.listAssets();
const usdc = assets.isOk()
  ? assets.value.find((a) => a.symbol === "USDC" && a.chain_namespace === "solana")
  : null;
step(!!usdc, "quotes.listAssets (USDC on solana)", usdc ? usdc.chain_reference : assets.isOk() ? "not found" : assets.error.message);

if (merchant.isOk() && usdc) {
  const quote = await zygo.quotes.create({
    merchantPaymentDestinationId: merchant.value.merchant_payment_destination_id,
    assetId: usdc.asset_id,
    fiatAmountMinor: 500_00,
  });
  step(quote.isOk(), "quotes.create", quote.isOk() ? `total ${quote.value.total_base} base units` : quote.error.message);

  if (quote.isOk()) {
    const order = await zygo.orders.create({ quoteId: quote.value.quote_id });
    step(order.isOk(), "orders.create", order.isOk() ? order.value.public_id : order.error.message);

    if (order.isOk()) {
      const got = await zygo.orders.get(order.value.order_id);
      step(got.isOk() && got.value.current_state === "quoted", "orders.get", got.isOk() ? got.value.current_state : got.error.message);

      const dep = await zygo.payments.depositInstructions(order.value.order_id);
      step(
        dep.isOk() && !!dep.value.path,
        "payments.depositInstructions",
        dep.isOk() ? `${dep.value.path} · ${dep.value.amount_base} base` : dep.error.message
      );

      const tl = await zygo.orders.timeline(order.value.order_id);
      step(tl.isOk() && tl.value.length > 0, "orders.timeline", tl.isOk() ? `${tl.value.length} events` : tl.error.message);
    }
  }
}

// --- 4. revoke the smoke key ---
await fetch(`${API}/v1/api-clients/${created.client.id}`, {
  method: "DELETE",
  headers: {
    Authorization: `Bearer ${ver.token}`,
    "Idempotency-Key": crypto.randomUUID(),
  },
});
const after = await fetch(`${API}/v1/api-clients`, {
  headers: { Authorization: `Bearer ${ver.token}` },
}).then((r) => r.json());
const revokedEntry = after.find((c) => c.client_id === created.client.client_id);
step(revokedEntry?.status === "revoked", "API key revoked");

console.log(failures === 0 ? "\nLIVE SMOKE PASSED" : `\n${failures} STEP(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
