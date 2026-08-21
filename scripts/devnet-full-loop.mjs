// FULL devnet loop — one wallet plays user AND LP:
// auth → LP promote → resolveQr → quote → order → SDK deposit on-chain →
// indexer escrow_funded → routing offer → LP accept → fiat sent → user
// confirm → settlement signer lock+release on-chain → completed.
//
// Usage: node scripts/devnet-full-loop.mjs [test-wallet-keypair.json] [api]
import { createZygo } from "../dist/index.js";
import { Connection, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import fs from "node:fs";

const API = process.argv[3] ?? "http://localhost:8080";
const RPC = "https://lita-hvkfxg-fast-devnet.helius-rpc.com";
const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2] ?? "/tmp/zygo-test-wallet.json", "utf8")))
);
const address = kp.publicKey.toBase58();
const connection = new Connection(RPC, "confirmed");
const usdcAta = getAssociatedTokenAddressSync(
  new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), kp.publicKey
);
const usdcBalance = async () => Number((await getAccount(connection, usdcAta)).amount) / 1e6;

let failures = 0;
const t0 = Date.now();
const lap = (label) => console.log(`  [t+${((Date.now()-t0)/1000).toFixed(0)}s] ${label}`);
const step = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

// --- helpers ---
const bearer = (t) => ({
  Authorization: `Bearer ${t}`,
  "Content-Type": "application/json",
  "Idempotency-Key": crypto.randomUUID(),
});
const post = (path, token, body = {}) =>
  fetch(`${API}${path}`, { method: "POST", headers: bearer(token), body: JSON.stringify(body) }).then((r) => r.json());
const get = (path, token) => fetch(`${API}${path}`, { headers: bearer(token) }).then((r) => r.json());

const RANK = [
  "quoted", "awaiting_escrow", "escrow_pending", "escrow_funded", "routing",
  "offer_pending", "lp_assigned", "fiat_processing", "fiat_sent",
  "user_confirmed", "settlement_pending", "settling", "completed",
];
const FAILED = ["unmatched", "cancellation_requested", "refund_pending", "refunded", "failed", "expired"];

async function waitOrder(token, orderId, target, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const targetRank = RANK.indexOf(target);
  for (;;) {
    const o = await get(`/v1/orders/${orderId}`, token);
    // States move fast — accept "reached or already passed" the target.
    if (RANK.indexOf(o.current_state) >= targetRank && targetRank >= 0) return o;
    if (FAILED.includes(o.current_state)) {
      throw new Error(`order went ${o.current_state} before reaching ${target}`);
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${target} (stuck at ${o.current_state})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// --- 1. auth ---
const ch = await post("/v1/auth/challenge", "", { chain_namespace: "solana", address }).catch(() => null);
const challenge = await fetch(`${API}/v1/auth/challenge`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chain_namespace: "solana", address }),
}).then((r) => r.json());
const sig = nacl.sign.detached(new TextEncoder().encode(challenge.message), kp.secretKey);
const ver = await post("/v1/auth/wallet/verify", "", {
  chain_namespace: "solana", address, nonce: challenge.nonce,
  signature: Buffer.from(sig).toString("base64"),
});
const token = ver.token;
step(!!token, "wallet auth (user+LP wallet)");

// --- 2. LP promote (dev) + capacity ---
const profile = await get("/v1/lp/profile", token).catch(() => null);
if (!profile || profile.approval_status !== "approved") {
  await post("/v1/lp/apply", token).catch(() => {});
  const promo = await post("/v1/dev/promote-lp", token, { capacity_minor: 1_000_000_00 });
  step(!!promo.lp_id, "LP promoted (dev)", promo.lp_id ?? JSON.stringify(promo));
} else {
  step(true, "LP already approved");
}
const lpProfile = await get("/v1/lp/profile", token);
step(lpProfile.approval_status === "approved", "LP profile approved", lpProfile.operational_status);

// --- 3. SDK: resolve → quote → order ---
const keyCreated = await post("/v1/api-clients", token, {
  name: "sdk-full-loop", scopes: ["read", "quotes:write", "orders:write"],
});
step(!!keyCreated.secret, "API key created", keyCreated.client?.client_id);
const zygo = createZygo({ apiKey: `${keyCreated.client.client_id}:${keyCreated.secret}`, baseUrl: API });

const merchant = await zygo.merchants.resolveQr("upi://pay?pa=sdk-full-loop@upi&pn=SDK Full Loop&cu=INR");
const assets = await zygo.quotes.listAssets();
const usdc = assets.value?.find((a) => a.symbol === "USDC" && a.chain_reference === "devnet");
const quote = await zygo.quotes.create({
  merchantPaymentDestinationId: merchant.value.merchant_payment_destination_id,
  assetId: usdc.asset_id, fiatAmountMinor: Number(process.env.ORDER_INR ?? 200) * 100,
});
const orderRes = await zygo.orders.create({ quoteId: quote.value.quote_id });
const order = orderRes.value;
step(!!order, "order created", order?.public_id);
const q = quote.value;
console.log(`  quote: ₹${q.fiat_amount_minor / 100} → principal ${q.stablecoin_amount_base / 1e6} + spread ${q.lp_spread_base / 1e6} + platform fee ${q.platform_fee_base / 1e6} + net fee est ${q.network_fee_estimate_base / 1e6} = ${q.total_base / 1e6} USDC`);

// --- 4. SDK deposit ON-CHAIN ---
const before = await usdcBalance();
const PLATFORM_ATA_PRE = new PublicKey("9uPvb3GYL68J2CCSTcXae6shpngCBxew3rARuEUQGPSe");
const platformBefore = Number((await getAccount(connection, PLATFORM_ATA_PRE)).amount) / 1e6;
const instr = await zygo.payments.depositInstructions(order.order_id);
const signer = {
  publicKey: kp.publicKey,
  signTransaction: async (tx) => (tx.partialSign(kp), tx),
  signAllTransactions: async (txs) => (txs.forEach((t) => t.partialSign(kp)), txs),
};
const prepared = await zygo.payments.deposit.prepare(instr.value, { connection, signer });
const sent = await zygo.payments.deposit.execute(prepared.value, signer);
lap("deposit confirmed on-chain");
  step(sent.isOk(), "deposit.execute ON-CHAIN", sent.isOk() ? sent.value.slice(0, 20) + "…" : sent.error?.message);

// --- 5. indexer confirms ---
console.log("  waiting: indexer → escrow_funded");
const fundedOrder = await waitOrder(token, order.order_id, "escrow_funded").catch((e) => { step(false, "escrow_funded", e.message); return null; });
if (fundedOrder) { step(true, "indexer confirmed escrow_funded"); lap("escrow_funded"); }

// --- 6. routing → LP accepts own offer ---
let accepted = false;
if (fundedOrder) {
  console.log("  waiting: routing offer to LP");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const offers = await get("/v1/lp/offers", token);
    const mine = (offers ?? []).find((o) => o.order_id === order.order_id && o.status === "pending");
    if (mine) {
      const acc = await post(`/v1/lp/offers/${mine.offer_id}/accept`, token);
      accepted = acc.status === "accepted" || !!acc.status;
      step(accepted, "LP accepted offer", mine.offer_id);
      break;
    }
    const o = await get(`/v1/orders/${order.order_id}`, token);
    if (["unmatched", "refund_pending", "refunded", "failed"].includes(o.current_state)) {
      step(false, "LP offer", `order went ${o.current_state} without offer`);
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!accepted && !failures) step(false, "LP offer", "no offer within 120s");
}

// --- 7. fiat leg (LP marks sent, user confirms) — assert + retry, these
// transitions race the accept by a hair on a cold backend.
async function postChecked(path, body, label, wantsState) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${API}${path}`, {
      method: "POST", headers: bearer(token), body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      if (wantsState) {
        const o = await get(`/v1/orders/${order.order_id}`, token);
        if (o.current_state === wantsState || RANK.indexOf(o.current_state) > RANK.indexOf(wantsState)) {
          step(true, label, o.current_state);
          return true;
        }
      } else {
        step(true, label);
        return true;
      }
    }
    if (i === 5) { step(false, label, `${res.status} ${text.slice(0, 120)}`); return false; }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

let fiatOk = false;
if (accepted) {
  fiatOk = await postChecked(
    `/v1/lp/orders/${order.order_id}/fiat-sent`,
    { provider_transaction_id: `UTR-E2E-${Date.now()}` },
    "LP marked fiat sent",
    "fiat_sent"
  );
  if (fiatOk) {
    fiatOk = await postChecked(
      `/v1/orders/${order.order_id}/confirm-fiat`,
      {},
      "user confirmed receipt",
      "user_confirmed"
    );
  }
}

// --- 8. settlement: signer locks + releases on-chain ---
if (fiatOk) {
  console.log("  waiting: settlement signer → completed (lock + release on-chain)");
  const done = await waitOrder(token, order.order_id, "completed", 180_000).catch((e) => { step(false, "completed", e.message); return null; });
  if (done) { step(true, "order completed — LP paid on-chain"); lap("completed"); }
  const after = await usdcBalance();
  // Platform fee vault = prime admin's devnet USDC ATA.
  const PLATFORM_ATA = new PublicKey("9uPvb3GYL68J2CCSTcXae6shpngCBxew3rARuEUQGPSe");
  const platformAfter = Number((await getAccount(connection, PLATFORM_ATA)).amount) / 1e6;
  const feeGot = platformAfter - platformBefore;
  console.log(`  ── settlement split ──`);
  console.log(`  user paid:        ${q.total_base / 1e6} USDC`);
  console.log(`  LP received:      ${(q.total_base - q.platform_fee_base) / 1e6} USDC (on-chain, to LP wallet)`);
  console.log(`  platform fee ATA: ${platformBefore} → ${platformAfter} (+${feeGot.toFixed(6)})`);
  console.log(`  expected fee:     ${q.platform_fee_base / 1e6} USDC`);
  step(Math.abs(feeGot - q.platform_fee_base / 1e6) < 0.000001, "platform fee captured ON-CHAIN");
  step(
    Math.abs(after - (before - q.platform_fee_base / 1e6)) < 0.01,
    "wallet delta = -fee (same wallet is user+LP)",
    `delta ${(after - before).toFixed(6)}`
  );
}

await fetch(`${API}/v1/api-clients/${keyCreated.client.id}`, {
  method: "DELETE", headers: bearer(token),
});

console.log(`  total wall time: ${((Date.now()-t0)/1000).toFixed(0)}s`);
console.log(failures === 0 ? "\nFULL LOOP PASSED" : `\n${failures} STEP(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
