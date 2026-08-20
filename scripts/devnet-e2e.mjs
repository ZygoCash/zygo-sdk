// Full devnet E2E through @zygopay/sdk — INCLUDING the on-chain deposit.
// resolveQr → quote → order → depositInstructions → deposit.execute →
// indexer-confirmed escrow_funded. Devnet only; uses a funded test wallet.
//
// Usage: node scripts/devnet-e2e.mjs [test-wallet-keypair.json] [api base url]
import { createZygo } from "../dist/index.js";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import fs from "node:fs";

const API = process.argv[3] ?? "http://localhost:8080";
const RPC = "https://lita-hvkfxg-fast-devnet.helius-rpc.com";
const keypairPath = process.argv[2] ?? "/tmp/zygo-test-wallet.json";

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

// wallet auth → API key (dev-mode path)
const ch = await fetch(`${API}/v1/auth/challenge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chain_namespace: "solana", address }),
}).then((r) => r.json());
const sig = nacl.sign.detached(new TextEncoder().encode(ch.message), kp.secretKey);
const ver = await fetch(`${API}/v1/auth/wallet/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chain_namespace: "solana", address, nonce: ch.nonce, signature: b64(sig) }),
}).then((r) => r.json());
step(!!ver.token, "wallet auth");

const created = await fetch(`${API}/v1/api-clients`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ver.token}`,
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({ name: "sdk-devnet-e2e", scopes: ["read", "quotes:write", "orders:write"] }),
}).then((r) => r.json());
step(!!created.secret, "API key created");

const zygo = createZygo({
  apiKey: `${created.client.client_id}:${created.secret}`,
  baseUrl: API,
});

// resolve → quote → order
const merchant = await zygo.merchants.resolveQr(
  "upi://pay?pa=sdk-e2e@upi&pn=SDK Devnet E2E&cu=INR"
);
step(merchant.isOk(), "resolveQr");
const assets = await zygo.quotes.listAssets();
const usdc = assets.isOk()
  ? assets.value.find((a) => a.symbol === "USDC" && a.chain_reference === "devnet")
  : null;
step(!!usdc, "listAssets devnet USDC");

let order;
if (merchant.isOk() && usdc) {
  const quote = await zygo.quotes.create({
    merchantPaymentDestinationId: merchant.value.merchant_payment_destination_id,
    assetId: usdc.asset_id,
    fiatAmountMinor: 500_00,
  });
  step(quote.isOk(), "quotes.create", quote.isOk() ? `${quote.value.total_base} base` : quote.error.message);
  if (quote.isOk()) {
    const res = await zygo.orders.create({ quoteId: quote.value.quote_id });
    step(res.isOk(), "orders.create", res.isOk() ? res.value.public_id : res.error.message);
    order = res.isOk() ? res.value : null;
  }
}

// THE on-chain deposit through the SDK
if (order) {
  const instr = await zygo.payments.depositInstructions(order.order_id);
  step(instr.isOk(), "depositInstructions", instr.isOk() ? instr.value.path : instr.error.message);
  if (instr.isOk()) {
    const connection = new Connection(RPC, "confirmed");
    const signer = {
      publicKey: kp.publicKey,
      signTransaction: async (tx) => (tx.partialSign(kp), tx),
      signAllTransactions: async (txs) => (txs.forEach((t) => t.partialSign(kp)), txs),
    };
    const prepared = await zygo.payments.deposit.prepare(instr.value, { connection, signer });
    step(prepared.isOk(), "deposit.prepare (tx built)", prepared.isOk() ? `${prepared.value.transaction.instructions.length} instructions` : prepared.error.message);
    if (prepared.isOk()) {
      const sent = await zygo.payments.deposit.execute(prepared.value, signer);
      step(sent.isOk(), "deposit.execute (ON-CHAIN)", sent.isOk() ? sent.value : sent.error.message);
      if (sent.isOk()) {
        console.log(`  tx: https://explorer.solana.com/tx/${sent.value}?cluster=devnet`);
      }
    }
  }

  // indexer should confirm the deposit → escrow_funded
  console.log("  waiting for indexer confirmation (escrow_funded)…");
  const funded = await zygo.orders.waitFor(order.order_id, "escrow_funded", {
    timeoutMs: 120_000,
    intervalMs: 4_000,
  });
  step(funded.isOk(), "indexer confirmed → escrow_funded", funded.isOk() ? funded.value.current_state : funded.error.message);
}

// cleanup
await fetch(`${API}/v1/api-clients/${created.client.id}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${ver.token}`, "Idempotency-Key": crypto.randomUUID() },
});

console.log(failures === 0 ? "\nDEVNET E2E PASSED (deposit on-chain)" : `\n${failures} STEP(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
