import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createZygo } from "../dist/index.js";

// Offline: pins the deposit transaction to the escrow program's v2 layout
// (mainnet 8mToj…). No RPC calls — the connection only hands out a blockhash.
const idl = JSON.parse(readFileSync(new URL("../dist/idl/zygo_escrow.json", import.meta.url), "utf8"));
const disc = (name) => Buffer.from(idl.instructions.find((i) => i.name === name).discriminator);

const PROGRAM = new PublicKey("8mTojgUC3bLUoZm7MhxGsZm34Wr1a1tpRtGDwg6euaUW");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const connection = { getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }) };

const zygo = () => createZygo({ apiKey: "zygo_c_test:zygo_s_test", baseUrl: "http://localhost:1" });
const signerFor = (kp) => ({ publicKey: kp.publicKey, signTransaction: async (t) => t });

function instructionsFor(depositor, { amount = 1_250_000, points = 0 } = {}) {
  const orderRef = crypto.createHash("sha256").update("order-" + crypto.randomUUID()).digest();
  const orderHash = crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from("zygo-escrow-v2"), depositor.toBuffer(), orderRef]))
    .digest();
  const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), orderHash], PROGRAM);
  return {
    escrow_id: "e1",
    chain: "solana",
    chain_name: "Solana",
    mint: USDC.toBase58(),
    program_id: PROGRAM.toBase58(),
    escrow_pda: escrowPda.toBase58(),
    order_hash: orderHash.toString("hex"),
    order_ref: orderRef.toString("hex"),
    amount_base: amount,
    reward_points: points,
    gross_base: amount,
    points_value_base: 0,
  };
}

test("bundled IDL is the mainnet v2 escrow program", () => {
  assert.equal(idl.address, PROGRAM.toBase58());
  const init = idl.instructions.find((i) => i.name === "initialize_escrow");
  assert.deepEqual(init.args.map((a) => a.name), ["order_hash", "amount", "reward_points", "order_ref"]);
});

test("deposit.prepare encodes initialize_escrow v2 + deposit", async () => {
  const kp = Keypair.generate();
  const instr = instructionsFor(kp.publicKey, { amount: 1_250_000, points: 40 });
  const res = await zygo().payments.deposit.prepare(instr, { connection, signer: signerFor(kp) });
  assert.ok(res.isOk(), res.isErr() ? res.error.message : "");
  const [init, dep] = res.value.transaction.instructions;
  assert.equal(res.value.transaction.instructions.length, 2);
  assert.ok(init.programId.equals(PROGRAM) && dep.programId.equals(PROGRAM));

  // discriminator(8) ‖ order_hash(32) ‖ amount u64 ‖ reward_points u64 ‖ order_ref(32)
  assert.equal(init.data.length, 88);
  assert.deepEqual(init.data.subarray(0, 8), disc("initialize_escrow"));
  assert.equal(init.data.subarray(8, 40).toString("hex"), instr.order_hash);
  assert.equal(init.data.readBigUInt64LE(40), 1_250_000n);
  assert.equal(init.data.readBigUInt64LE(48), 40n);
  assert.equal(init.data.subarray(56, 88).toString("hex"), instr.order_ref);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM);
  const [poolState] = PublicKey.findProgramAddressSync([Buffer.from("pool_state"), USDC.toBuffer()], PROGRAM);
  const escrow = new PublicKey(instr.escrow_pda);
  const vault = getAssociatedTokenAddressSync(USDC, escrow, true);
  const keys = init.keys.map((k) => k.pubkey.toBase58());
  assert.equal(init.keys.length, 10);
  assert.equal(keys[0], config.toBase58());
  assert.equal(keys[1], escrow.toBase58());
  assert.equal(keys[2], vault.toBase58());
  assert.equal(keys[3], USDC.toBase58());
  assert.equal(keys[4], kp.publicKey.toBase58());
  assert.ok(init.keys[4].isSigner && init.keys[4].isWritable);
  assert.equal(keys[9], poolState.toBase58());

  assert.deepEqual(dep.data, disc("deposit"));
  assert.deepEqual(
    dep.keys.map((k) => k.pubkey.toBase58()).slice(0, 4),
    [escrow, vault, getAssociatedTokenAddressSync(USDC, kp.publicKey), kp.publicKey].map((k) => k.toBase58())
  );
  assert.ok(res.value.transaction.feePayer.equals(kp.publicKey));
});

test("reward_points defaults to 0 when the backend omits it", async () => {
  const kp = Keypair.generate();
  const { reward_points, ...instr } = instructionsFor(kp.publicKey);
  const res = await zygo().payments.deposit.prepare(instr, { connection, signer: signerFor(kp) });
  assert.ok(res.isOk(), res.isErr() ? res.error.message : "");
  assert.equal(res.value.transaction.instructions[0].data.readBigUInt64LE(48), 0n);
});

test("refuses a signer other than the prepared depositor", async () => {
  const instr = instructionsFor(Keypair.generate().publicKey);
  const res = await zygo().payments.deposit.prepare(instr, { connection, signer: signerFor(Keypair.generate()) });
  assert.ok(res.isErr());
  assert.equal(res.error.code, "DEPOSITOR_MISMATCH");
  assert.equal(res.error.retryable, false);
});

test("refuses instructions without order_ref (pre-v2 backend)", async () => {
  const kp = Keypair.generate();
  const { order_ref, ...instr } = instructionsFor(kp.publicKey);
  const res = await zygo().payments.deposit.prepare(instr, { connection, signer: signerFor(kp) });
  assert.ok(res.isErr());
  assert.equal(res.error.code, "INVALID_DEPOSIT_INSTRUCTIONS");
});

test("refuses an escrow_pda that does not match program + order_hash", async () => {
  const kp = Keypair.generate();
  const instr = { ...instructionsFor(kp.publicKey), escrow_pda: Keypair.generate().publicKey.toBase58() };
  const res = await zygo().payments.deposit.prepare(instr, { connection, signer: signerFor(kp) });
  assert.ok(res.isErr());
  assert.equal(res.error.code, "INVALID_DEPOSIT_INSTRUCTIONS");
});

// depositInstructions → POST /escrow/prepare body
const realFetch = globalThis.fetch;
let bodies;
beforeEach(() => {
  bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push({ url, body: opts.body });
    return new Response(JSON.stringify({ escrow_id: "e1" }), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("depositInstructions sends points only when asked", async () => {
  await zygo().payments.depositInstructions("o1");
  await zygo().payments.depositInstructions("o1", { points: 25 });
  assert.match(bodies[0].url, /\/v1\/orders\/o1\/escrow\/prepare$/);
  assert.equal(bodies[0].body, "{}");
  assert.equal(bodies[1].body, JSON.stringify({ points: 25 }));
});
