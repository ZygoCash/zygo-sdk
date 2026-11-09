import { createHash } from "node:crypto";
import { ResultAsync } from "neverthrow";
import type { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { ZygoError } from "./index.js";
import { HttpConfig, request } from "./http.js";
import { DepositInstructions, DepositInstructionsOptions } from "./types.js";

/**
 * Minimal Solana signer — the consumer's wallet signs; the SDK never holds
 * keys. Matches the wallet-adapter / AppKit provider shape.
 */
export interface TxSigner {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
  signAndSendTransaction?: (tx: Transaction) => Promise<string | { signature: string }>;
}

export interface PreparedDeposit {
  transaction: Transaction;
  connection: Connection;
}

/** Matches the escrow program's ORDER_HASH_TAG. */
const ORDER_HASH_TAG = "zygo-escrow-v2";

const toErr = (e: unknown, code = "CHAIN_ERROR", retryable = true) =>
  e instanceof ZygoError
    ? e
    : new ZygoError(e instanceof Error ? e.message : String(e), code, 0, retryable);

const badInstr = (message: string) =>
  new ZygoError(message, "INVALID_DEPOSIT_INSTRUCTIONS", 0, false);

function hex32(value: string | undefined, field: string): Buffer {
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw badInstr(`deposit instructions: ${field} must be 32 bytes of hex`);
  }
  return Buffer.from(value, "hex");
}

/**
 * Payments covers the on-chain funding step. Solana deps
 * (@solana/web3.js, @solana/spl-token, @coral-xyz/anchor) are optional peer
 * dependencies, dynamically imported only when prepare/execute is used.
 */
export function createPayments(cfg: HttpConfig) {
  return {
    /**
     * Moves the order to escrow-pending and returns deposit instructions
     * for the account's primary Solana wallet. Pass `{ points }` to pay part
     * of the order with Zygo points.
     */
    depositInstructions(
      orderId: string,
      opts: DepositInstructionsOptions = {}
    ): ResultAsync<DepositInstructions, ZygoError> {
      const body = opts.points ? { points: opts.points } : {};
      return request(cfg, "POST", `/v1/orders/${orderId}/escrow/prepare`, body);
    },

    deposit: {
      /**
       * Builds the unsigned escrow-program deposit transaction for the
       * signer's wallet — inspect or simulate it before signing. The signer
       * must be the wallet the instructions were prepared for (the
       * account's primary Solana wallet).
       */
      prepare(
        instr: DepositInstructions,
        opts: { connection: Connection; signer: TxSigner }
      ): ResultAsync<PreparedDeposit, ZygoError> {
        return ResultAsync.fromPromise(buildDeposit(instr, opts.connection, opts.signer), toErr);
      },

      /** Signs, sends and confirms a prepared deposit. Returns the signature. */
      execute(prepared: PreparedDeposit, signer: TxSigner): ResultAsync<string, ZygoError> {
        return ResultAsync.fromPromise(
          (async () => {
            const { connection, transaction } = prepared;
            if (signer.signAndSendTransaction) {
              const res = await signer.signAndSendTransaction(transaction);
              const signature = typeof res === "string" ? res : res.signature;
              await connection.confirmTransaction(signature, "confirmed");
              return signature;
            }
            const signed = await signer.signTransaction(transaction);
            const sig = await connection.sendRawTransaction(signed.serialize());
            await connection.confirmTransaction(sig, "confirmed");
            return sig;
          })(),
          toErr
        );
      },
    },
  };
}

async function buildDeposit(
  instr: DepositInstructions,
  connection: Connection,
  signer: TxSigner
): Promise<PreparedDeposit> {
  if (!instr.program_id || !instr.escrow_pda || !instr.mint) {
    throw badInstr("deposit instructions missing program_id/escrow_pda/mint");
  }
  const orderHash = hex32(instr.order_hash, "order_hash");
  const orderRef = hex32(instr.order_ref, "order_ref");

  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const anchor = await import("@coral-xyz/anchor");

  const owner = signer.publicKey;
  const programId = new web3.PublicKey(instr.program_id);
  const mint = new web3.PublicKey(instr.mint);
  const escrowPda = new web3.PublicKey(instr.escrow_pda);

  // The program recomputes the seed from (depositor, order_ref) and rejects a
  // mismatch; checking here turns a failed transaction into a clear error.
  const expectedHash = createHash("sha256")
    .update(ORDER_HASH_TAG)
    .update(owner.toBuffer())
    .update(orderRef)
    .digest();
  if (!expectedHash.equals(orderHash)) {
    throw new ZygoError(
      `signer ${owner.toBase58()} is not the wallet this deposit was prepared for — sign with the account's primary Solana wallet`,
      "DEPOSITOR_MISMATCH",
      0,
      false
    );
  }
  const [derivedPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), orderHash],
    programId
  );
  if (!derivedPda.equals(escrowPda)) {
    throw badInstr("deposit instructions: escrow_pda does not match program_id + order_hash");
  }

  const idl = (await import("./idl/zygo_escrow.json", { with: { type: "json" } })).default;
  const signAll =
    signer.signAllTransactions ??
    (async (txs: Transaction[]) => {
      const out: Transaction[] = [];
      for (const t of txs) out.push(await signer.signTransaction(t));
      return out;
    });
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: owner, signTransaction: signer.signTransaction, signAllTransactions: signAll } as never,
    { commitment: "confirmed" }
  );
  // The backend's deposit instructions carry the active program id (devnet
  // and mainnet differ); the bundled IDL's address is only a fallback.
  const program = new anchor.Program({ ...idl, address: instr.program_id } as never, provider);

  // initialize_escrow is pause-gated through the config PDA, and the
  // pool_state PDA is the mint allowlist (only mints prime set up).
  const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [poolStatePda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), mint.toBuffer()],
    programId
  );
  const userAta = await spl.getAssociatedTokenAddress(mint, owner);
  const vault = await spl.getAssociatedTokenAddress(mint, escrowPda, true);

  const tx = new web3.Transaction();
  tx.add(
    await program.methods
      .initializeEscrow(
        Array.from(orderHash),
        new anchor.BN(instr.amount_base),
        new anchor.BN(instr.reward_points ?? 0),
        Array.from(orderRef)
      )
      .accounts({
        config: configPda,
        escrow: escrowPda,
        vault,
        mint,
        user: owner,
        poolState: poolStatePda,
      })
      .instruction(),
    await program.methods
      .deposit()
      .accounts({ escrow: escrowPda, vault, userAta, user: owner })
      .instruction()
  );

  tx.feePayer = owner;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return { transaction: tx, connection };
}
