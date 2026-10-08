import { test } from "node:test";
import assert from "node:assert/strict";
import { Networks, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import {
  balanceOp,
  buildTransaction,
  decodeInvocation,
  depShareToScVal,
  distributePoolOp,
  memoHash,
  networkFromEnv,
  payOp,
  PLACEHOLDER_CONTRACT_ID,
  projectIdBySlugOp,
  registerProjectOp,
  shareToScVal,
  updateSplitsOp,
  withdrawOp,
} from "../src/contract.js";
import { parseArgs } from "../src/cli.js";

const CONTRACT = PLACEHOLDER_CONTRACT_ID;
const OWNER = "GDK3IJY3Z6BHCTRRHEEEH3ABMRDL5NTOTGHT5H44AIM7ASXOKRO5VVG3";
const A1 = "GDK7SBO7JYLB2VU26E5GM3CFAKWS7HUOYBHG2YWN3QO3XKLL4BR2ZA3A";
const A2 = "GDOAECAI7JQWDD3MYLSBJWCUQNT7KMRXLUHNWABX37CRK7KZGZ27G23J";
const PAYER = "GBJIDJ5RLIRCNK5A5YOKUYABRDUWGSCRJXSIZHWXKMN6YFGSH4XHEUHD";
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function mapEntries(v: xdr.ScVal): xdr.ScMapEntry[] {
  if (v.type !== "scvMap" || !v.map) throw new Error(`expected a map, got ${v.type}`);
  return v.map;
}
function symbolOf(v: xdr.ScVal): string {
  if (v.type !== "scvSymbol") throw new Error(`expected a symbol, got ${v.type}`);
  return v.value;
}

test("struct encoding: Share and DepShare are symbol-keyed maps with sorted keys (contracttype layout)", () => {
  const share = shareToScVal({ addr: A1, bps: 4000 });
  assert.deepEqual(
    mapEntries(share).map((e) => symbolOf(e.key)),
    ["addr", "bps"],
  );
  const dep = depShareToScVal({ project_id: 7, bps: 2000 });
  assert.deepEqual(
    mapEntries(dep).map((e) => symbolOf(e.key)),
    ["bps", "project_id"],
  );
  const pid = mapEntries(dep)[1].val;
  assert.equal(pid.type, "scvU32");
  assert.equal(pid.value, 7);
  assert.throws(() => shareToScVal({ addr: A1, bps: -1 }), /not a u32/);
  assert.throws(() => shareToScVal({ addr: "not-an-address", bps: 1 }));
});

test("register_project op encodes owner, slug, maintainers and dependencies and decodes back", () => {
  const op = registerProjectOp(
    CONTRACT,
    OWNER,
    "quickparse",
    [
      { addr: A1, bps: 4000 },
      { addr: A2, bps: 3000 },
    ],
    [
      { project_id: 2, bps: 2000 },
      { project_id: 1, bps: 1000 },
    ],
  );
  const { fn, args } = decodeInvocation(op);
  assert.equal(fn, "register_project");
  assert.deepEqual(args, [
    OWNER,
    "quickparse",
    [
      { addr: A1, bps: 4000 },
      { addr: A2, bps: 3000 },
    ],
    [
      { bps: 2000, project_id: 2 },
      { bps: 1000, project_id: 1 },
    ],
  ]);
  assert.equal(op.body.type, "invokeHostFunction");
  if (op.body.type === "invokeHostFunction") {
    assert.equal(op.body.invokeHostFunctionOp.hostFunction.type, "hostFunctionTypeInvokeContract");
  }
});

test("pay op carries id, payer, token, i128 amount and 32-byte memo hash", () => {
  const memo = memoHash("Q3 dependency fund - quickparse");
  assert.equal(memo.length, 32);
  assert.equal(memo.toString("hex"), memoHash("Q3 dependency fund - quickparse").toString("hex"));
  assert.notEqual(memo.toString("hex"), memoHash("Q3 dependency fund - quickparse ").toString("hex"));

  const op = payOp(CONTRACT, 3, PAYER, TOKEN, 50_000_000_000n, memo);
  const { fn, args } = decodeInvocation(op);
  assert.equal(fn, "pay");
  assert.equal(args[0], 3);
  assert.equal(args[1], PAYER);
  assert.equal(args[2], TOKEN);
  assert.equal(args[3], 50_000_000_000n);
  assert.equal(Buffer.from(args[4] as Uint8Array).toString("hex"), memo.toString("hex"));
  assert.throws(() => payOp(CONTRACT, 3, PAYER, TOKEN, 0n, memo), /> 0/);
  assert.throws(() => payOp(CONTRACT, 3, PAYER, TOKEN, 1n, Buffer.alloc(31)), /32 bytes/);

  // Amounts beyond 64 bits survive the i128 encoding.
  const big = payOp(CONTRACT, 3, PAYER, TOKEN, 1n << 100n, memo);
  assert.equal(decodeInvocation(big).args[3], 1n << 100n);
});

test("update_splits, distribute_pool, withdraw and view ops", () => {
  assert.deepEqual(decodeInvocation(updateSplitsOp(CONTRACT, 3, [{ addr: A1, bps: 5500 }], [{ project_id: 2, bps: 3000 }, { project_id: 1, bps: 1500 }])), {
    fn: "update_splits",
    args: [3, [{ addr: A1, bps: 5500 }], [{ bps: 3000, project_id: 2 }, { bps: 1500, project_id: 1 }]],
  });
  assert.deepEqual(decodeInvocation(distributePoolOp(CONTRACT, 2, TOKEN)), { fn: "distribute_pool", args: [2, TOKEN] });
  assert.deepEqual(decodeInvocation(withdrawOp(CONTRACT, TOKEN, A1)), { fn: "withdraw", args: [TOKEN, A1] });
  assert.deepEqual(decodeInvocation(balanceOp(CONTRACT, TOKEN, A1)), { fn: "balance", args: [TOKEN, A1] });
  assert.deepEqual(decodeInvocation(projectIdBySlugOp(CONTRACT, "bufring")), { fn: "project_id_by_slug", args: ["bufring"] });
});

test("buildTransaction produces a signable single-operation transaction envelope offline", () => {
  const op = withdrawOp(CONTRACT, TOKEN, A1);
  const tx = buildTransaction(op, { publicKey: A1, sequence: "123456789" }, Networks.TESTNET, 30);
  assert.equal(tx.operations.length, 1);
  assert.equal(tx.source, A1);
  assert.equal(tx.sequence, "123456790");
  assert.equal(tx.networkPassphrase, Networks.TESTNET);
  const envelope = tx.toEnvelope();
  const env = envelope.toXdr("base64");
  const back = TransactionBuilder.fromXDR(env, Networks.TESTNET);
  assert.equal(back.toEnvelope().toXdr("base64"), env);
  assert.equal(envelope.type, "envelopeTypeTx");
  if (envelope.type === "envelopeTypeTx") {
    assert.equal(envelope.v1.tx.operations.length, 1);
    assert.equal(decodeInvocation(envelope.v1.tx.operations[0]).fn, "withdraw");
  }
});

test("networkFromEnv defaults to testnet and reads overrides", () => {
  const d = networkFromEnv({});
  assert.equal(d.rpcUrl, "https://soroban-testnet.stellar.org");
  assert.equal(d.networkPassphrase, Networks.TESTNET);
  assert.equal(d.contractId, "");
  const o = networkFromEnv({ SOROBAN_RPC_URL: "http://localhost:8000/soroban/rpc", NETWORK_PASSPHRASE: "Standalone Network ; February 2017", DEPSPLIT_CONTRACT_ID: CONTRACT });
  assert.equal(o.rpcUrl, "http://localhost:8000/soroban/rpc");
  assert.equal(o.contractId, CONTRACT);
});

test("CLI argument parsing: positionals, --flag value, --flag=value, boolean flags", () => {
  assert.deepEqual(parseArgs(["pay", "quickparse", "1234.5", "--memo", "Sept grant", "--dry-run"]), {
    command: "pay",
    positionals: ["quickparse", "1234.5"],
    flags: { memo: "Sept grant", "dry-run": true },
  });
  assert.deepEqual(parseArgs(["import", "a.json", "b.json", "--out=plan.json"]), {
    command: "import",
    positionals: ["a.json", "b.json"],
    flags: { out: "plan.json" },
  });
  assert.deepEqual(parseArgs(["statement", PAYER, "--payments", "p.csv", "--out", "s.csv"]).flags, { payments: "p.csv", out: "s.csv" });
  assert.deepEqual(parseArgs([]), { command: "help", positionals: [], flags: {} });
  assert.deepEqual(parseArgs(["withdraw", "--dry-run", "--to", A1]).flags, { "dry-run": true, to: A1 });
});
