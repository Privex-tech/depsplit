/**
 * Transaction building for `split_router` with @stellar/stellar-sdk 17.
 *
 * Everything in this file except `SplitRouterRpc` is pure and offline: it
 * turns plain values into the ScVals the contract expects (struct fields as
 * sorted symbol-keyed maps, exactly like `#[contracttype]` encodes them) and
 * wraps them in an `invokeHostFunction` operation. `SplitRouterRpc` is the only
 * place that talks to Soroban RPC.
 */
import { createHash } from "node:crypto";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

/** Well-formed placeholder ids for `--dry-run` and tests (all-zero payloads with a valid checksum). */
export const PLACEHOLDER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));
export const PLACEHOLDER_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

export interface ShareArg {
  addr: string;
  bps: number;
}
export interface DepShareArg {
  project_id: number;
  bps: number;
}

export interface ProjectView {
  id: number;
  owner: string;
  slug: string;
  version: number;
  maintainers: ShareArg[];
  dependencies: DepShareArg[];
  active: boolean;
}

/** sha256 of the memo text: what goes on-chain in `pay` as `memo_hash`. */
export function memoHash(memo: string): Buffer {
  return createHash("sha256").update(memo, "utf8").digest();
}

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u32 = (n: number) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error(`not a u32: ${n}`);
  return xdr.ScVal.scvU32(n);
};

/** `Share { addr, bps }` -> ScMap with keys in sorted order (addr < bps). */
export function shareToScVal(s: ShareArg): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym("addr"), val: new Address(s.addr).toScVal() }),
    new xdr.ScMapEntry({ key: sym("bps"), val: u32(s.bps) }),
  ]);
}

/** `DepShare { project_id, bps }` -> ScMap, keys sorted (bps < project_id). */
export function depShareToScVal(d: DepShareArg): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym("bps"), val: u32(d.bps) }),
    new xdr.ScMapEntry({ key: sym("project_id"), val: u32(d.project_id) }),
  ]);
}

export function i128ToScVal(amount: bigint): xdr.ScVal {
  return nativeToScVal(amount, { type: "i128" });
}

export function memoHashToScVal(hash: Buffer): xdr.ScVal {
  if (hash.length !== 32) throw new Error("memo hash must be 32 bytes");
  return xdr.ScVal.scvBytes(hash);
}

// ---------------------------------------------------------------------------
// Operations (offline)
// ---------------------------------------------------------------------------

export function registerProjectOp(
  contractId: string,
  owner: string,
  slug: string,
  maintainers: ShareArg[],
  dependencies: DepShareArg[],
): xdr.Operation {
  return new Contract(contractId).call(
    "register_project",
    new Address(owner).toScVal(),
    nativeToScVal(slug, { type: "string" }),
    xdr.ScVal.scvVec(maintainers.map(shareToScVal)),
    xdr.ScVal.scvVec(dependencies.map(depShareToScVal)),
  );
}

export function updateSplitsOp(contractId: string, id: number, maintainers: ShareArg[], dependencies: DepShareArg[]): xdr.Operation {
  return new Contract(contractId).call(
    "update_splits",
    u32(id),
    xdr.ScVal.scvVec(maintainers.map(shareToScVal)),
    xdr.ScVal.scvVec(dependencies.map(depShareToScVal)),
  );
}

export function payOp(contractId: string, id: number, from: string, token: string, amount: bigint, memo: Buffer): xdr.Operation {
  if (amount <= 0n) throw new Error("amount must be > 0");
  return new Contract(contractId).call(
    "pay",
    u32(id),
    new Address(from).toScVal(),
    new Address(token).toScVal(),
    i128ToScVal(amount),
    memoHashToScVal(memo),
  );
}

export function distributePoolOp(contractId: string, id: number, token: string): xdr.Operation {
  return new Contract(contractId).call("distribute_pool", u32(id), new Address(token).toScVal());
}

export function withdrawOp(contractId: string, token: string, to: string): xdr.Operation {
  return new Contract(contractId).call("withdraw", new Address(token).toScVal(), new Address(to).toScVal());
}

export function setActiveOp(contractId: string, id: number, active: boolean): xdr.Operation {
  return new Contract(contractId).call("set_active", u32(id), xdr.ScVal.scvBool(active));
}

export function balanceOp(contractId: string, token: string, addr: string): xdr.Operation {
  return new Contract(contractId).call("balance", new Address(token).toScVal(), new Address(addr).toScVal());
}
export function poolOp(contractId: string, token: string, id: number): xdr.Operation {
  return new Contract(contractId).call("pool", new Address(token).toScVal(), u32(id));
}
export function projectOp(contractId: string, id: number): xdr.Operation {
  return new Contract(contractId).call("project", u32(id));
}
export function projectIdBySlugOp(contractId: string, slug: string): xdr.Operation {
  return new Contract(contractId).call("project_id_by_slug", nativeToScVal(slug, { type: "string" }));
}
export function projectCountOp(contractId: string): xdr.Operation {
  return new Contract(contractId).call("project_count");
}

/** Decode an invokeHostFunction op back into (function name, native args). Used by tests and `--dry-run`. */
export function decodeInvocation(op: xdr.Operation): { fn: string; args: unknown[] } {
  const body = op.body;
  if (body.type !== "invokeHostFunction") throw new Error(`not an invokeHostFunction operation: ${body.type}`);
  const hf = body.invokeHostFunctionOp.hostFunction;
  if (hf.type !== "hostFunctionTypeInvokeContract") throw new Error(`not a contract invocation: ${hf.type}`);
  const inv = hf.invokeContract;
  return {
    fn: inv.functionName.toString(),
    args: inv.args.map((a: xdr.ScVal) => scValToNative(a)),
  };
}

/**
 * Wrap one operation in an unsigned transaction. `sourceAccount` needs the
 * current sequence number, which is why online callers fetch it via RPC first;
 * offline callers (tests, `--dry-run`) can pass any sequence.
 */
export function buildTransaction(
  op: xdr.Operation,
  source: { publicKey: string; sequence: string },
  networkPassphrase: string,
  timeoutSeconds = 60,
): Transaction {
  const account = new Account(source.publicKey, source.sequence);
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase }).addOperation(op).setTimeout(timeoutSeconds).build();
}

// ---------------------------------------------------------------------------
// RPC (online only)
// ---------------------------------------------------------------------------

export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
}

export function networkFromEnv(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const rpcUrl = env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const networkPassphrase = env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
  const contractId = env.DEPSPLIT_CONTRACT_ID ?? "";
  return { rpcUrl, networkPassphrase, contractId };
}

export class SplitRouterRpc {
  readonly server: rpc.Server;
  constructor(readonly cfg: NetworkConfig) {
    if (!cfg.contractId) throw new Error("DEPSPLIT_CONTRACT_ID is not set (deploy first: scripts/deploy-testnet.sh)");
    this.server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
  }

  /** Simulate a read-only call from `viewer` and decode the return value. */
  async view<T = unknown>(op: xdr.Operation, viewer: string): Promise<T> {
    const acc = await this.server.getAccount(viewer);
    const tx = buildTransaction(op, { publicKey: acc.accountId(), sequence: acc.sequenceNumber() }, this.cfg.networkPassphrase);
    const sim = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`simulation failed: ${(sim as rpc.Api.SimulateTransactionErrorResponse).error}`);
    }
    if (!sim.result) throw new Error("simulation returned no result");
    return scValToNative(sim.result.retval) as T;
  }

  /** Simulate, assemble (footprint + resource fees), sign, submit, wait. Returns the tx hash and decoded return value. */
  async invoke<T = unknown>(op: xdr.Operation, signer: Keypair): Promise<{ hash: string; result: T }> {
    const acc = await this.server.getAccount(signer.publicKey());
    const tx = buildTransaction(op, { publicKey: acc.accountId(), sequence: acc.sequenceNumber() }, this.cfg.networkPassphrase);
    const sim = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`simulation failed: ${(sim as rpc.Api.SimulateTransactionErrorResponse).error}`);
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(signer);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`submit failed: ${sent.errorResult?.toXdr("base64") ?? sent.status}`);
    }
    const hash = sent.hash;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const got = await this.server.getTransaction(hash);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const retval = got.returnValue ? (scValToNative(got.returnValue) as T) : (undefined as T);
        return { hash, result: retval };
      }
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`transaction ${hash} failed: ${got.resultXdr?.toXdr("base64")}`);
      }
    }
    throw new Error(`transaction ${hash} not confirmed after 60s`);
  }
}

export { Keypair, Operation };
