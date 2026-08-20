import { ResultAsync } from "neverthrow";
import type { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { ZygoError } from "./index.js";
import { HttpConfig, request } from "./http.js";
import { DepositInstructions } from "./types.js";

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

const toErr = (e: unknown, code = "CHAIN_ERROR", retryable = true) =>
  e instanceof ZygoError
    ? e
    : new ZygoError(e instanceof Error ? e.message : String(e), code, 0, retryable);

/**
 * Payments covers the on-chain funding step. Solana deps
 * (@solana/web3.js, @solana/spl-token, @coral-xyz/anchor) are optional peer
 * dependencies, dynamically imported only when prepare/execute is used.
 */
export function createPayments(cfg: HttpConfig) {
  return {
    /** Moves the order to escrow-pending and returns deposit instructions. */
    depositInstructions(orderId: string): ResultAsync<DepositInstructions, ZygoError> {
      return request(cfg, "POST", `/v1/orders/${orderId}/escrow/prepare`, {});
    },

    deposit: {
      /**
       * Builds the unsigned deposit transaction for the signer's wallet —
       * inspect or simulate it before signing. Program path (escrow PDA)
       * or vault-transfer fallback, chosen from the instructions.
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

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

async function buildDeposit(
  instr: DepositInstructions,
  connection: Connection,
  signer: TxSigner
): Promise<PreparedDeposit> {
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");

  const owner = signer.publicKey;
  const mint = new web3.PublicKey(instr.mint);
  const tx = new web3.Transaction();

  if (instr.path === "program" && instr.escrow_pda && instr.order_hash && instr.program_id) {
    // Escrow program path: initialize_escrow + deposit in one transaction.
    const anchor = await import("@coral-xyz/anchor");
    const idl = (await import("./idl/zygo_escrow.json")).default;
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
    const program = new anchor.Program(idl as never, provider);
    const escrowPda = new web3.PublicKey(instr.escrow_pda);
    const orderHash = Buffer.from(instr.order_hash, "hex");
    const userAta = await spl.getAssociatedTokenAddress(mint, owner);
    const vault = await spl.getAssociatedTokenAddress(mint, escrowPda, true);

    tx.add(
      await program.methods
        .initializeEscrow(Array.from(orderHash), new anchor.BN(instr.amount_base))
        .accounts({ escrow: escrowPda, vault, mint, user: owner })
        .instruction(),
      await program.methods
        .deposit()
        .accounts({ escrow: escrowPda, vault, userAta, user: owner })
        .instruction()
    );
  } else {
    // Vault-transfer fallback: ATA (create if missing) + transferChecked + memo.
    const vault = new web3.PublicKey(instr.vault_address);
    const userAta = await spl.getAssociatedTokenAddress(mint, owner);
    if (!(await connection.getAccountInfo(userAta))) {
      tx.add(spl.createAssociatedTokenAccountInstruction(owner, userAta, owner, mint));
    }
    tx.add(
      spl.createTransferCheckedInstruction(userAta, mint, vault, owner, instr.amount_base, 6),
      new web3.TransactionInstruction({
        keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
        programId: new web3.PublicKey(MEMO_PROGRAM),
        data: Buffer.from(instr.memo, "utf8"),
      })
    );
  }

  tx.feePayer = owner;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return { transaction: tx, connection };
}
