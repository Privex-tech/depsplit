import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegisterPlan, FundingParseError, parseFundingJson } from "../src/funding.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(here, "..", "..", "..", "data", "seed");
const FIXTURES = path.resolve(here, "..", "..", "test", "fixtures");

async function seed(name: string) {
  return parseFundingJson(await fs.readFile(path.join(SEED, name), "utf8"), name);
}

test("parses the three seed manifests, normalising messy fields with warnings", async () => {
  const bufring = await seed("funding-bufring.json");
  assert.equal(bufring.entity.type, "individual");
  assert.equal(bufring.entity.email, "tasnim.chowdhury@example.org"); // lowercased
  assert.equal(bufring.projects.length, 1);
  const p = bufring.projects[0];
  assert.equal(p.slug, "bufring");
  assert.equal(p.name, "bufring"); // trimmed
  assert.deepEqual(p.licenses, ["spdx:MIT", "spdx:Apache-2.0"]); // trimmed
  assert.equal(p.maintainers.length, 3);
  assert.equal(p.maintainers[2].address, "GD3Z6RCZL6YJ4PQXWYNKMNKMTZIBOPUH26PTVKC5DIYGXZCOMW7IDATV"); // trimmed
  assert.match(p.maintainers[0].note ?? "", /not on Stripe's Express payout country list/);
  assert.ok(bufring.warnings.some((w) => /email lowercased/.test(w)));
  assert.ok(bufring.warnings.some((w) => /address trimmed/.test(w)));

  const utf8 = await seed("funding-utf8-guard.json");
  assert.equal(utf8.projects[0].slug, "utf8-guard"); // "UTF8-Guard" normalised
  assert.equal(utf8.projects[0].maintainers[0].bps, 7000); // "7000" coerced
  assert.ok(utf8.warnings.some((w) => /guid normalised/.test(w)));
  assert.ok(utf8.warnings.some((w) => /bps given as a string/.test(w)));
  assert.deepEqual(utf8.projects[0].dependencies, [{ slug: "bufring", bps: 3000 }]);

  const qp = await seed("funding-quickparse.json");
  assert.equal(qp.entity.type, "organisation");
  assert.equal(qp.projects.length, 2);
  // top-level x-stellar.owner is the default owner
  assert.equal(qp.projects[0].owner, "GDK3IJY3Z6BHCTRRHEEEH3ABMRDL5NTOTGHT5H44AIM7ASXOKRO5VVG3");
  assert.equal(qp.projects[1].owner, qp.projects[0].owner);
  assert.deepEqual(
    qp.projects[0].dependencies,
    [
      { slug: "utf8-guard", bps: 2000 },
      { slug: "bufring", bps: 1000 },
    ],
  );
  assert.equal(qp.projects[1].maintainers.map((m) => m.bps).reduce((a, b) => a + b, 0), 10_000);
});

test("invalid manifest: every problem is reported and nothing is returned", async () => {
  const text = await fs.readFile(path.join(FIXTURES, "funding-invalid.json"), "utf8");
  assert.throws(
    () => parseFundingJson(text, "funding-invalid.json"),
    (e: unknown) => {
      assert.ok(e instanceof FundingParseError);
      const joined = e.problems.join("\n");
      assert.match(joined, /projects\[0\]\.name is required/);
      assert.match(joined, /owner is not a valid Stellar address \(not-an-address\)/);
      assert.match(joined, /maintainers\[1\]\.bps must be an integer/);
      assert.match(joined, /duplicate maintainer GDK7SBO7/);
      assert.match(joined, /\("broken-project"\): a project cannot depend on itself/);
      assert.match(joined, /dependency broken-project: bps must be > 0/);
      assert.match(joined, /projects\[1\] \("no-extension"\) has no x-stellar block/);
      assert.match(joined, /projects\[2\]\.guid "bad slug!" must match/);
      assert.match(joined, /\("bad slug!"\): bps must sum to 10000, got 9000/);
      assert.equal(e.problems.length, 11, joined);
      return true;
    },
  );
});

test("invalid manifest: bps not summing to 10000, bad address, missing entity, malformed JSON", () => {
  const base = {
    version: "v1",
    entity: { type: "individual", role: "owner", name: "X" },
    projects: [
      {
        guid: "p",
        name: "P",
        "x-stellar": {
          owner: "GDK3IJY3Z6BHCTRRHEEEH3ABMRDL5NTOTGHT5H44AIM7ASXOKRO5VVG3",
          maintainers: [{ address: "GDK7SBO7JYLB2VU26E5GM3CFAKWS7HUOYBHG2YWN3QO3XKLL4BR2ZA3A", bps: 9_000 }],
          dependencies: [],
        },
      },
    ],
  };
  assert.throws(() => parseFundingJson(JSON.stringify(base)), /bps must sum to 10000, got 9000/);

  const badAddr = structuredClone(base);
  badAddr.projects[0]["x-stellar"].maintainers[0].bps = 10_000;
  badAddr.projects[0]["x-stellar"].maintainers[0].address = "GDK7SBO7JYLB2VU26E5GM3CFAKWS7HUOYBHG2YWN3QO3XKLL4BR2ZA3B"; // bad checksum
  assert.throws(() => parseFundingJson(JSON.stringify(badAddr)), /not a valid Stellar address/);

  const noEntity = { version: "v1", projects: base.projects };
  assert.throws(() => parseFundingJson(JSON.stringify(noEntity)), /entity is required/);

  assert.throws(() => parseFundingJson("{ not json"), /not valid JSON/);
  assert.throws(() => parseFundingJson("[]"), /top level must be an object/);
  assert.throws(() => parseFundingJson(JSON.stringify({ ...base, version: "v2" })), /version must be "v1"/);
});

test("register plan orders dependencies first and rejects unresolved ones", async () => {
  const files = await Promise.all(["funding-quickparse.json", "funding-utf8-guard.json", "funding-bufring.json"].map(seed));
  const plan = buildRegisterPlan(files);
  assert.deepEqual(
    plan.projects.map((p) => p.slug),
    ["bufring", "utf8-guard", "quickparse", "quickparse-cli"],
  );
  for (const p of plan.projects) {
    const idx = plan.projects.indexOf(p);
    for (const d of p.dependencies) {
      const depIdx = plan.projects.findIndex((x) => x.slug === d.slug);
      assert.ok(depIdx >= 0 && depIdx < idx, `${d.slug} must precede ${p.slug}`);
    }
  }
  assert.ok(plan.warnings.length >= 3);

  // quickparse alone: its dependencies are unresolved...
  assert.throws(() => buildRegisterPlan([files[0]]), /depends on "utf8-guard" which is neither/);
  // ...unless they are already registered.
  const partial = buildRegisterPlan([files[0]], ["utf8-guard", "bufring"]);
  assert.deepEqual(
    partial.projects.map((p) => p.slug),
    ["quickparse", "quickparse-cli"],
  );
  // already-registered projects in the files are skipped with a warning
  const skip = buildRegisterPlan(files, ["bufring"]);
  assert.deepEqual(
    skip.projects.map((p) => p.slug),
    ["utf8-guard", "quickparse", "quickparse-cli"],
  );
  assert.ok(skip.warnings.some((w) => /"bufring" is already registered/.test(w)));
});

test("register plan detects cycles and duplicates across files", () => {
  const mk = (slug: string, dep: string) =>
    parseFundingJson(
      JSON.stringify({
        version: "v1",
        entity: { type: "individual", role: "owner", name: slug },
        projects: [
          {
            guid: slug,
            name: slug,
            "x-stellar": {
              owner: "GDK3IJY3Z6BHCTRRHEEEH3ABMRDL5NTOTGHT5H44AIM7ASXOKRO5VVG3",
              maintainers: [{ address: "GDK7SBO7JYLB2VU26E5GM3CFAKWS7HUOYBHG2YWN3QO3XKLL4BR2ZA3A", bps: 8000 }],
              dependencies: [{ slug: dep, bps: 2000 }],
            },
          },
        ],
      }),
      `${slug}.json`,
    );
  assert.throws(() => buildRegisterPlan([mk("a", "b"), mk("b", "a")]), /dependency cycle a -> b -> a/);
  assert.throws(() => buildRegisterPlan([mk("a", "b"), mk("a", "b"), mk("b", "c")], ["c"]), /appears in both/);
});
