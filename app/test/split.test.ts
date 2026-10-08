import { test } from "node:test";
import assert from "node:assert/strict";
import { BPS_DENOMINATOR, formatAmount, parseAmount, shareOf, splitAmount, validateTable, type SplitTable } from "../src/split.js";

const OWNER = "GDK3IJY3Z6BHCTRRHEEEH3ABMRDL5NTOTGHT5H44AIM7ASXOKRO5VVG3";
const A1 = "GDK7SBO7JYLB2VU26E5GM3CFAKWS7HUOYBHG2YWN3QO3XKLL4BR2ZA3A";
const A2 = "GDOAECAI7JQWDD3MYLSBJWCUQNT7KMRXLUHNWABX37CRK7KZGZ27G23J";

test("shareOf floors like the contract", () => {
  assert.equal(shareOf(12_345_678_901n, 4000), 4_938_271_560n);
  assert.equal(shareOf(12_345_678_901n, 3000), 3_703_703_670n);
  assert.equal(shareOf(1n, 9999), 0n);
  assert.equal(shareOf(10_000n, 1), 1n);
  assert.throws(() => shareOf(1n, 10_001));
  assert.throws(() => shareOf(-1n, 1));
});

test("splitAmount mirrors the contract's scenario numbers to the stroop", () => {
  // Same table and amount as the Rust test `pay_credits_maintainers_pools_and_dust_exactly`.
  const table: SplitTable = {
    owner: OWNER,
    maintainers: [
      { address: A1, bps: 4000 },
      { address: A2, bps: 3000 },
    ],
    dependencies: [{ slug: "dep", bps: 3000 }],
  };
  const r = splitAmount(12_345_678_901n, table);
  assert.equal(r.dust, 1n);
  assert.deepEqual(
    r.lines.map((l) => [l.type, l.recipient, l.amount]),
    [
      ["maintainer", A1, 4_938_271_560n],
      ["maintainer", A2, 3_703_703_670n],
      ["dependency", "dep", 3_703_703_670n],
      ["dust", OWNER, 1n],
    ],
  );
  const sum = r.lines.reduce((acc, l) => acc + l.amount, 0n);
  assert.equal(sum, 12_345_678_901n);

  // Version-2 numbers from `scenario_three_projects`: 55/30/15 on the same amount.
  const v2: SplitTable = {
    owner: OWNER,
    maintainers: [{ address: A1, bps: 5500 }],
    dependencies: [
      { slug: "utf8-guard", bps: 3000 },
      { slug: "bufring", bps: 1500 },
    ],
  };
  const r2 = splitAmount(12_345_678_901n, v2);
  assert.equal(r2.lines[0].amount, 6_790_123_395n);
  assert.equal(r2.lines[1].amount, 3_703_703_670n);
  assert.equal(r2.lines[2].amount, 1_851_851_835n);
  assert.equal(r2.dust, 1n);
});

test("splitAmount: no dust line when the split is exact", () => {
  const table: SplitTable = {
    owner: OWNER,
    maintainers: [
      { address: A1, bps: 6000 },
      { address: A2, bps: 4000 },
    ],
    dependencies: [],
  };
  const r = splitAmount(50_000_000_000n, table);
  assert.equal(r.dust, 0n);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].amount + r.lines[1].amount, 50_000_000_000n);
});

test("property: random tables never create or lose value; dust bounded by share count", () => {
  // xorshift for reproducibility
  let s = 0x9e3779b97f4a7c15n;
  const rnd = () => {
    s ^= s >> 12n;
    s ^= (s << 25n) & 0xffffffffffffffffn;
    s ^= s >> 27n;
    return (s * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
  };
  const below = (n: bigint) => rnd() % n;
  for (let iter = 0; iter < 500; iter++) {
    const nM = 1 + Number(below(6n));
    const nD = Number(below(3n));
    const n = nM + nD;
    const cuts = new Set<number>();
    while (cuts.size < n - 1) cuts.add(1 + Number(below(9999n)));
    const sorted = [...cuts].sort((a, b) => a - b);
    const parts: number[] = [];
    let prev = 0;
    for (const c of sorted) {
      parts.push(c - prev);
      prev = c;
    }
    parts.push(BPS_DENOMINATOR - prev);
    const table: SplitTable = {
      owner: OWNER,
      maintainers: parts.slice(0, nM).map((bps, i) => ({ address: `M${i}`, bps })),
      dependencies: parts.slice(nM).map((bps, i) => ({ slug: `d${i}`, bps })),
    };
    const amount = iter % 3 === 0 ? 1n + below(20n) : iter % 3 === 1 ? 1n + below(10_000_000_000n) : 1n + rnd() * 1_000_003n;
    const r = splitAmount(amount, table);
    const sum = r.lines.reduce((acc, l) => acc + l.amount, 0n);
    assert.equal(sum, amount, `iteration ${iter}: sum ${sum} != amount ${amount}`);
    assert.ok(r.dust >= 0n && r.dust < BigInt(n), `iteration ${iter}: dust ${r.dust} out of bounds`);
    for (const l of r.lines.filter((l) => l.type !== "dust")) {
      assert.equal(l.amount, (amount * BigInt(l.bps)) / 10_000n);
    }
  }
});

test("validateTable reports the same conditions the contract rejects", () => {
  const ok: SplitTable = { owner: OWNER, maintainers: [{ address: A1, bps: 10_000 }], dependencies: [] };
  assert.deepEqual(validateTable(ok), []);
  assert.match(validateTable({ owner: OWNER, maintainers: [], dependencies: [] }).join(";"), /at least one maintainer/);
  assert.match(validateTable({ owner: OWNER, maintainers: [{ address: A1, bps: 9_999 }], dependencies: [] }).join(";"), /sum to 10000, got 9999/);
  assert.match(
    validateTable({ owner: OWNER, maintainers: [{ address: A1, bps: 5000 }, { address: A1, bps: 5000 }], dependencies: [] }).join(";"),
    /duplicate maintainer/,
  );
  assert.match(
    validateTable({ owner: OWNER, maintainers: [{ address: A1, bps: 5000 }, { address: A2, bps: 0 }], dependencies: [{ slug: "x", bps: 5000 }] }).join(";"),
    /bps must be > 0/,
  );
  assert.match(
    validateTable({ owner: OWNER, maintainers: [{ address: A1, bps: 5000 }], dependencies: [{ slug: "self", bps: 5000 }] }, "self").join(";"),
    /cannot depend on itself/,
  );
  assert.match(
    validateTable({ owner: OWNER, maintainers: [{ address: A1, bps: 4000 }], dependencies: [{ slug: "x", bps: 3000 }, { slug: "x", bps: 3000 }] }).join(";"),
    /duplicate dependency/,
  );
  assert.match(validateTable({ owner: OWNER, maintainers: [{ address: A1, bps: 12.5 }], dependencies: [] }).join(";"), /integer/);
  const many: SplitTable = { owner: OWNER, maintainers: Array.from({ length: 33 }, (_, i) => ({ address: `M${i}`, bps: i === 0 ? 10_000 - 32 : 1 })), dependencies: [] };
  assert.match(validateTable(many).join(";"), /more than 32 maintainers/);
  assert.throws(() => splitAmount(1n, { owner: OWNER, maintainers: [], dependencies: [] }), /invalid split table/);
  assert.throws(() => splitAmount(0n, ok), /> 0/);
});

test("parseAmount and formatAmount round-trip at stroop precision and reject junk", () => {
  assert.equal(parseAmount("5000"), 50_000_000_000n);
  assert.equal(parseAmount("5,000.00"), 50_000_000_000n);
  assert.equal(parseAmount(" 1234.5678901 "), 12_345_678_901n);
  assert.equal(parseAmount("0.0000001"), 1n);
  assert.equal(parseAmount("250.5"), 2_505_000_000n);
  assert.equal(formatAmount(12_345_678_901n), "1234.5678901");
  assert.equal(formatAmount(1n), "0.0000001");
  assert.equal(formatAmount(50_000_000_000n), "5000.0000000");
  assert.equal(formatAmount(-1n), "-0.0000001");
  assert.throws(() => parseAmount("0.00000001"), /more than 7 decimals/);
  assert.throws(() => parseAmount("0"), /must be > 0/);
  assert.throws(() => parseAmount("-5"), /cannot parse/);
  assert.throws(() => parseAmount("five"), /cannot parse/);
  assert.throws(() => parseAmount("1e3"), /cannot parse/);
  for (const v of [1n, 7n, 12_345_678_901n, 99_999_999_999_999n]) {
    assert.equal(parseAmount(formatAmount(v)), v);
  }
});
