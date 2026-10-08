# DepSplit demo

Everything below runs offline (no RPC). Commands are relative to `stellar/depsplit/`.
Amounts printed by the contract tests are stroops (1 USDC = 10,000,000).

## 1. Contract scenario: three projects, one payer, pools, re-versioning

```bash
cargo test -- --nocapture scenario_three_projects
```

Expected output (addresses are generated per run, numbers are deterministic):

```
running 1 test
== DepSplit scenario: three projects ==
registered: quickparse=#3 (v1), utf8-guard=#2 (v1), bufring=#1 (v1)
foundation paid quickparse 5000.0000000 and utf8-guard 1000.0000000
after pay: a1=20000000000 a2=15000000000 b1=7000000000 pool(utf8-guard)=10000000000 pool(bufring)=8000000000
after distribute: b1=14000000000 c1=4950000000 c2=3300000000 c3=2750000000
withdrawn: c3=2750000000 a1=20000000000
quickparse table updated -> version 2
company paid 12345678901 under v2: a1 +6790123395 pool(utf8-guard) +3703703670 pool(bufring) +1851851835 dust->owner_a 1
final: contract holds 49595678901 = sum of balances 49595678901; a1=6790123395 a2=15000000000 b1=16592592569 c1=6283333321 c2=4188888880 c3=740740734 owners a/b/c=1/0/1
all balances withdrawn; contract holds 0
Writing test snapshot file for test "test::scenario_three_projects" to "test_snapshots/test/scenario_three_projects.1.json".
test test::scenario_three_projects ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 17 filtered out; finished in 0.23s
```

What it shows, step by step:

| Step | Table | Effect |
|---|---|---|
| pay quickparse 5,000 | a1 40%, a2 30%, utf8-guard 20%, bufring 10% | a1 2,000, a2 1,500, pool(utf8-guard) 1,000, pool(bufring) 500 |
| pay utf8-guard 1,000 | b1 70%, bufring 30% | b1 700, pool(bufring) +300 = 800 |
| distribute utf8-guard | same | b1 +700 = 1,400, pool(bufring) +300 = 1,100 |
| distribute bufring | c1 45%, c2 30%, c3 25% | c1 495, c2 330, c3 275; no dust |
| withdraw c3, a1 | | tokens leave the contract; other balances untouched |
| update_splits quickparse | a1 55%, utf8-guard 30%, bufring 15% | version 2; a2's 1,500 stays |
| pay quickparse 1,234.5678901 (v2) | | a1 +679.0123395, pools +370.3703670 / +185.1851835, dust 0.0000001 to owner |
| distribute both again | | every balance asserted to the stroop; contract holds exactly the sum owed |

The full suite:

```bash
cargo test
# test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
stellar contract build
# target/wasm32v1-none/release/split_router.wasm  (15,864 bytes)
```

## 2. App tests

```bash
cd app && npm install && npm test
# ...
# tests 22
# pass 22
# fail 0
```

## 3. CLI walk-through on the seed data

### Import three manifests into a register plan

```bash
node dist/src/cli.js import ../data/seed/funding-quickparse.json \
  ../data/seed/funding-utf8-guard.json ../data/seed/funding-bufring.json --out ../data/plan.json
```

```
plan written to ../data/plan.json

4 project(s) in registration order:
  bufring  maintainers=3  deps=none  owner=GALGKY...
      note (Tasnim Chowdhury): Lives in Bangladesh, which is not on Stripe's Express payout country list: GitHub Sponsors application has been pending since 2024. Cashes out through a local SEP-24 anchor.
      note (Ondřej Sýkora): prefers to withdraw quarterly
  utf8-guard  maintainers=1  deps=bufring:3000  owner=GCS6JZ...
  quickparse  maintainers=2  deps=utf8-guard:2000, bufring:1000  owner=GDK3IJ...
      note (Hanna Lindqvist): prefers monthly withdrawals
  quickparse-cli  maintainers=3  deps=none  owner=GDK3IJ...

5 warning(s):
  - funding-utf8-guard.json: projects[0].guid normalised ("UTF8-Guard" -> "utf8-guard")
  - funding-utf8-guard.json: projects[0].x-stellar.maintainers[0].bps given as a string ("7000"), coerced
  - funding-bufring.json: entity.email lowercased (Tasnim.Chowdhury@Example.org)
  - funding-bufring.json: projects[0].name trimmed
  - funding-bufring.json: projects[0].x-stellar.maintainers[2].address trimmed
```

Dependencies come first even though `funding-quickparse.json` was listed first.

### Register (dry run: decoded invocations, no network)

```bash
node dist/src/cli.js register ../data/plan.json --dry-run
```

```
{
  "fn": "register_project",
  "args": [
    "GALGKYFOG4C7GDMOUAP4NWIT4FLQIEZCJO6FK63UDAMBCSNHM6OUFTVM",
    "bufring",
    [
      { "addr": "GCJXYABCESAM6QJ5RL7ITT7TO5APC2I3JEMW4UHO2PUODE6CJYVIKPJL", "bps": 4500 },
      { "addr": "GAJIRTXU7V3P2O5YIGL5G4454SBHNX4XTBF5IF6XU4XQIHKKC3LQKL22", "bps": 3000 },
      { "addr": "GD3Z6RCZL6YJ4PQXWYNKMNKMTZIBOPUH26PTVKC5DIYGXZCOMW7IDATV", "bps": 2500 }
    ],
    []
  ]
}
{
  "fn": "register_project",
  "args": [
    "GCS6JZTKZPWVDYCVGM537G2O3EXUHSCIYSLSVFXSXLQYM7RLE3HGSHMP",
    "utf8-guard",
    [ { "addr": "GCEV7CGJWVUHEJFI23QO3GVNDDI5X3H5THGGVT5WNAL6AIKZXAI4NC3M", "bps": 7000 } ],
    [ { "bps": 3000, "project_id": 1 } ]
  ]
}
... (quickparse -> deps #2 and #1, then quickparse-cli)
```

(Output is pretty-printed one field per line; condensed here.)

### Pay (dry run)

```bash
DEPSPLIT_REGISTRY=test/fixtures/registry.json \
USDC_CONTRACT_ID=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
node dist/src/cli.js pay quickparse 5000 --memo "Q3 dependency fund - quickparse" --dry-run
```

```
{
  "fn": "pay",
  "args": [
    3,
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "50000000000",
    "e3604049d4e7533eb7a4a4ff2cda6afe6f8839cfecd002255069422e8421bafa"
  ],
  "memo": "Q3 dependency fund - quickparse",
  "memo_hash": "e3604049d4e7533eb7a4a4ff2cda6afe6f8839cfecd002255069422e8421bafa"
}
```

The payer placeholder is the all-zero account because no `DEPSPLIT_SECRET` is set in a dry run.

### Statement for the foundation's books

```bash
node dist/src/cli.js statement GBJIDJ5RLIRCNK5A5YOKUYABRDUWGSCRJXSIZHWXKMN6YFGSH4XHEUHD \
  --payments ../data/seed/payments.csv --registry test/fixtures/registry.json
```

```
warning: line 7: amount "0.00000001" has more than 7 decimals (stroop precision)
payment_date,payer,memo,tx_hash,project_slug,project_id,version,line_type,recipient,bps,amount
2026-09-01,GBJID...HEUHD,Q3 dependency fund - quickparse,,quickparse,3,1,payment,quickparse,10000,5000.0000000
2026-09-01,GBJID...HEUHD,Q3 dependency fund - quickparse,,quickparse,3,1,maintainer,GDK7S...ZA3A,4000,2000.0000000
2026-09-01,GBJID...HEUHD,Q3 dependency fund - quickparse,,quickparse,3,1,maintainer,GDOAE...G23J,3000,1500.0000000
2026-09-01,GBJID...HEUHD,Q3 dependency fund - quickparse,,quickparse,3,1,dependency,utf8-guard,2000,1000.0000000
2026-09-01,GBJID...HEUHD,Q3 dependency fund - quickparse,,quickparse,3,1,dependency,bufring,1000,500.0000000
2026-09-01,GBJID...HEUHD,Q3 dependency fund - utf8-guard,,utf8-guard,2,1,payment,utf8-guard,10000,1000.0000000
2026-09-01,GBJID...HEUHD,Q3 dependency fund - utf8-guard,,utf8-guard,2,1,maintainer,GCEV7...NC3M,7000,700.0000000
2026-09-01,GBJID...HEUHD,Q3 dependency fund - utf8-guard,,utf8-guard,2,1,dependency,bufring,3000,300.0000000
2026-09-20,GBJID...HEUHD,"Direct tip, ""keep the CI green"" plan",,bufring,1,1,payment,bufring,10000,250.5000000
2026-09-20,GBJID...HEUHD,"Direct tip, ""keep the CI green"" plan",,bufring,1,1,maintainer,GCJXY...KPJL,4500,112.7250000
2026-09-20,GBJID...HEUHD,"Direct tip, ""keep the CI green"" plan",,bufring,1,1,maintainer,GAJIR...KL22,3000,75.1500000
2026-09-20,GBJID...HEUHD,"Direct tip, ""keep the CI green"" plan",,bufring,1,1,maintainer,GD3Z6...DATV,2500,62.6250000
2026-09-22,GBJID...HEUHD,odd amount to exercise 3333/3333/3334 rounding,,quickparse-cli,4,1,payment,quickparse-cli,10000,99.9999999
2026-09-22,GBJID...HEUHD,odd amount to exercise 3333/3333/3334 rounding,,quickparse-cli,4,1,maintainer,GDK7S...ZA3A,3333,33.3299999
2026-09-22,GBJID...HEUHD,odd amount to exercise 3333/3333/3334 rounding,,quickparse-cli,4,1,maintainer,GDOAE...G23J,3333,33.3299999
2026-09-22,GBJID...HEUHD,odd amount to exercise 3333/3333/3334 rounding,,quickparse-cli,4,1,maintainer,GAO3H...IREQ,3334,33.3399999
2026-09-22,GBJID...HEUHD,odd amount to exercise 3333/3333/3334 rounding,,quickparse-cli,4,1,dust,GDK3I...VVG3,,0.0000002
```

(Addresses are abbreviated here; the real output prints them in full.) The company's payments in
the same CSV are not in the foundation's statement; running it for
`GABVKWEZ3UELW3XALXTLWWCROSX2E2GP3KVJOIKEQWHBA3KKCNAQJ3X4` shows the version-2 split of
1,234.5678901 (679.0123395 / 370.3703670 / 185.1851835 / dust 0.0000001) and an `unresolved`
line for the typo'd slug `quikparse`.

### An invalid manifest is rejected with every problem listed

```bash
node dist/src/cli.js import test/fixtures/funding-invalid.json; echo "exit=$?"
```

```
funding-invalid.json: 11 problem(s)
  - projects[0].name is required
  - projects[0].x-stellar.owner is not a valid Stellar address (not-an-address)
  - projects[0].x-stellar.maintainers[1].bps must be an integer number of basis points (got 39.99)
  - projects[0] ("broken-project"): duplicate maintainer GDK7SBO7JYLB2VU26E5GM3CFAKWS7HUOYBHG2YWN3QO3XKLL4BR2ZA3A
  - projects[0] ("broken-project"): maintainer GDK7SBO7JYLB2VU26E5GM3CFAKWS7HUOYBHG2YWN3QO3XKLL4BR2ZA3A: bps must be an integer (got 39.99)
  - projects[0] ("broken-project"): a project cannot depend on itself
  - projects[0] ("broken-project"): dependency broken-project: bps must be > 0
  - projects[0] ("broken-project"): bps sum is 6000, expected 10000
  - projects[1] ("no-extension") has no x-stellar block (owner, maintainers, dependencies)
  - projects[2].guid "bad slug!" must match /^[a-z0-9][a-z0-9-]*$/
  - projects[2] ("bad slug!"): bps must sum to 10000, got 9000
exit=1
```

## 4. Testnet (not executed here)

`scripts/deploy-testnet.sh` prints `DEPSPLIT_CONTRACT_ID` and `USDC_CONTRACT_ID`; export them with a
funded `DEPSPLIT_SECRET` and drop `--dry-run` from the commands above. The build sandbox could not
reach testnet, so there is no recorded output for this section.
