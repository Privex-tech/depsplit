import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, registryLookup } from "../src/registry.js";
import { parseAmount } from "../src/split.js";
import { buildStatement, parseCsv, parsePaymentsCsv, statementToCsv, STATEMENT_HEADER, sumAmounts, toCsv } from "../src/statement.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(here, "..", "..", "..", "data", "seed");
const FIXTURES = path.resolve(here, "..", "..", "test", "fixtures");
const FOUNDATION = "GBJIDJ5RLIRCNK5A5YOKUYABRDUWGSCRJXSIZHWXKMN6YFGSH4XHEUHD";
const COMPANY = "GABVKWEZ3UELW3XALXTLWWCROSX2E2GP3KVJOIKEQWHBA3KKCNAQJ3X4";

test("parseCsv handles quotes, embedded commas, escaped quotes, CRLF, BOM and blank lines", () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\n\n2,,3\n');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "x, y", 'say "hi"'],
    ["2", "", "3"],
  ]);
  assert.equal(toCsv(["a", "b"], [{ a: "x, y", b: 'q"q' }]), 'a,b\n"x, y","q""q"\n');
});

test("parsePaymentsCsv on the messy seed file: thousands separators, spaces, case, bad rows reported", async () => {
  const { rows, problems } = parsePaymentsCsv(await fs.readFile(path.join(SEED, "payments.csv"), "utf8"));
  assert.equal(rows.length, 6);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /line 7: amount "0.00000001" has more than 7 decimals/);
  assert.equal(rows[0].amount, 50_000_000_000n); // "5,000.00"
  assert.equal(rows[2].amount, 12_345_678_901n); // " 1234.5678901 "
  assert.equal(rows[2].projectSlug, "quickparse"); // "Quickparse" lowercased
  assert.equal(rows[2].version, 2);
  assert.equal(rows[2].memo, "Invoice INV-2026-091, quickparse support contract");
  assert.equal(rows[4].memo, 'Direct tip, "keep the CI green" plan');
  assert.equal(rows[3].projectSlug, "quikparse");
  assert.equal(rows[3].projectId, undefined);
});

test("statement CSV shape: header, payment line then split lines summing to the payment, per memo", async () => {
  const reg = await loadRegistry(path.join(FIXTURES, "registry.json"), "test", "C");
  const { rows } = parsePaymentsCsv(await fs.readFile(path.join(SEED, "payments.csv"), "utf8"));
  const lines = buildStatement(FOUNDATION, rows, registryLookup(reg));
  const csv = statementToCsv(lines);
  const csvRows = parseCsv(csv);
  assert.deepEqual(csvRows[0], [...STATEMENT_HEADER]);
  assert.equal(csvRows.length, lines.length + 1);

  // Foundation made 4 parseable payments: quickparse(v1), utf8-guard(v1), bufring(v1), quickparse-cli(v1)
  const payments = lines.filter((l) => l.line_type === "payment");
  assert.deepEqual(
    payments.map((p) => [p.project_slug, p.version, p.amount, p.memo]),
    [
      ["quickparse", "1", "5000.0000000", "Q3 dependency fund - quickparse"],
      ["utf8-guard", "1", "1000.0000000", "Q3 dependency fund - utf8-guard"],
      ["bufring", "1", "250.5000000", 'Direct tip, "keep the CI green" plan'],
      ["quickparse-cli", "1", "99.9999999", "odd amount to exercise 3333/3333/3334 rounding"],
    ],
  );
  // No company payments leak into the foundation's statement.
  assert.ok(lines.every((l) => l.payer === FOUNDATION));

  // Each payment's split lines sum exactly to the payment amount.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].line_type !== "payment") continue;
    let j = i + 1;
    let sum = 0n;
    while (j < lines.length && lines[j].line_type !== "payment" && lines[j].line_type !== "unresolved") {
      sum += parseAmount(lines[j].amount);
      j++;
    }
    assert.equal(sum, parseAmount(lines[i].amount), `split of ${lines[i].memo} does not add up`);
  }

  // quickparse v1: 5000 -> 2000 / 1500 / 1000 (utf8-guard pool) / 500 (bufring pool), no dust
  const qp = lines.slice(1, 5);
  assert.deepEqual(
    qp.map((l) => [l.line_type, l.recipient, l.bps, l.amount]),
    [
      ["maintainer", "GDK7SBO7JYLB2VU26E5GM3CFAKWS7HUOYBHG2YWN3QO3XKLL4BR2ZA3A", "4000", "2000.0000000"],
      ["maintainer", "GDOAECAI7JQWDD3MYLSBJWCUQNT7KMRXLUHNWABX37CRK7KZGZ27G23J", "3000", "1500.0000000"],
      ["dependency", "utf8-guard", "2000", "1000.0000000"],
      ["dependency", "bufring", "1000", "500.0000000"],
    ],
  );
  // quickparse-cli 99.9999999 over 3333/3333/3334 leaves dust for the owner.
  const cli = lines.filter((l) => l.project_slug === "quickparse-cli");
  assert.equal(cli.length, 5); // payment + 3 maintainers + dust
  assert.equal(cli[4].line_type, "dust");
  assert.equal(cli[4].recipient, "GDK3IJY3Z6BHCTRRHEEEH3ABMRDL5NTOTGHT5H44AIM7ASXOKRO5VVG3");
  assert.equal(cli[1].amount, "33.3299999"); // floor(999_999_999 * 3333 / 10000) = 333_299_999
  assert.equal(cli[3].amount, "33.3399999"); // floor(999_999_999 * 3334 / 10000) = 333_399_999
  assert.equal(cli[4].amount, "0.0000002");
  assert.equal(sumAmounts(lines, "payment"), 50_000_000_000n + 10_000_000_000n + 2_505_000_000n + 999_999_999n);
  assert.equal(sumAmounts(lines, "maintainer") + sumAmounts(lines, "dependency") + sumAmounts(lines, "dust"), sumAmounts(lines, "payment"));
});

test("statement follows the table version recorded on the payment; unknown slugs are 'unresolved'", async () => {
  const reg = await loadRegistry(path.join(FIXTURES, "registry.json"), "test", "C");
  const { rows } = parsePaymentsCsv(await fs.readFile(path.join(SEED, "payments.csv"), "utf8"));
  const lines = buildStatement(COMPANY, rows, registryLookup(reg));
  // quickparse v2 (55/30/15) on 1234.5678901 -> 679.0123395 / 370.3703670 / 185.1851835 / dust 0.0000001
  const v2 = lines.filter((l) => l.project_slug === "quickparse");
  assert.equal(v2[0].line_type, "payment");
  assert.equal(v2[0].version, "2");
  assert.deepEqual(
    v2.slice(1).map((l) => [l.line_type, l.bps, l.amount]),
    [
      ["maintainer", "5500", "679.0123395"],
      ["dependency", "3000", "370.3703670"],
      ["dependency", "1500", "185.1851835"],
      ["dust", "", "0.0000001"],
    ],
  );
  const bad = lines.filter((l) => l.project_slug === "quikparse");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line_type, "unresolved");
  assert.equal(bad[0].amount, "50.0000000");
  // Nobody else's payments.
  assert.equal(buildStatement("GNOBODY", rows, registryLookup(reg)).length, 0);
});
