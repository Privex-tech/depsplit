# DepSplit

Dependency-aware payout splits for open-source maintainers on Stellar (Soroban).

A foundation or company pays a project **once** in USDC. An on-chain split table routes the
payment to the project's maintainers and, one hop down, to the projects it depends on. Every
recipient pulls their balance whenever they want, from any non-sanctioned country, and cashes out
through a Stellar anchor instead of waiting on a Stripe Connect account that may never be approved.

## Problem

- GitHub Sponsors pays through Stripe Connect Express, which covers roughly 70 countries. A
  maintainer in Bangladesh has been on the waiting list "for years" and GitHub cannot expedite
  unsupported regions (GitHub community discussion 175076).
- Supported maintainers still wait: 124 days with no payout, a second maintainer ~$1,000 unpaid
  after 88 days, Stripe confirming the payout was "manually configured and awaiting GitHub's
  trigger" (discussion 180328).
- Algora settles bounties by bank transfer in 23 countries at a 9% organisation fee; Open Collective's
  fiscal hosts take ~10% and still pay through Stripe/PayPal/Wise.
- Web3 alternatives (Drips on Ethereum, Gitcoin in maintenance mode) pay into an EVM wallet with no
  local-currency exit, which is the step that fails.

Sources: `research/05-problems-infra-data-ai-climate.md` (P1, P2) and
`research/08-final-selection.md` (section 03). Details and evidence tiers in [VALIDATION.md](VALIDATION.md).

## Users

| Role | Who | What they do here |
|---|---|---|
| Payer | OSPO / foundation programme manager, company with a dependency budget | `depsplit pay`, `depsplit statement` for their books |
| Owner | Project maintainer who publishes `funding.json` | `depsplit import`, `register`, `update-splits` |
| Payee | Maintainer in Dhaka, Lagos, Karachi, Hanoi... | `depsplit withdraw`, then a SEP-24 anchor cash-out |
| Anyone | A bot, the payer, a maintainer | `depsplit distribute` to settle the next hop |

## What the MVP does

1. **`split_router` contract** (`contracts/split_router`): projects with a versioned split table
   (maintainer shares + dependency shares in basis points, summing to exactly 10 000).
   `pay` moves USDC into the contract and credits balances and dependency pools; `distribute_pool`
   settles a dependency's pool one hop further; `withdraw` is pull-only. Events on every state change.
2. **CLI** (`app/`): `import` parses FLOSS/fund `funding.json` manifests (plus an `x-stellar`
   extension with addresses, bps and dependency slugs) into a register plan; `register`, `pay`,
   `distribute`, `withdraw` build and submit Soroban transactions; `statement` produces a CSV of
   payments and their split lines for the payer's accounting. `--dry-run` prints the decoded
   contract invocation without a network.
3. **Seed data** (`data/seed/`): three manifests forming a dependency graph
   (`quickparse` -> `utf8-guard` -> `bufring`, plus `quickparse-cli`), one maintainer flagged as
   living outside Stripe's payout list, and a messy payments CSV.
4. **Scripts**: `scripts/build.sh` (tests + wasm), `scripts/deploy-testnet.sh` (written, **not run** here).

## Quickstart

Prerequisites: Rust 1.94 with the `wasm32v1-none` target, stellar-cli 28, Node 22 (see `TOOLCHAIN.md`).

```bash
cd stellar/depsplit

# Contract: 18 tests executed in the Soroban host, then the wasm.
cargo test
stellar contract build            # -> target/wasm32v1-none/release/split_router.wasm

# App: 22 offline tests (parsing, split maths, statement CSV, transaction building, CLI args).
cd app && npm install && npm test

# Offline CLI walk-through on the seed data.
node dist/src/cli.js import ../data/seed/funding-quickparse.json \
     ../data/seed/funding-utf8-guard.json ../data/seed/funding-bufring.json --out ../data/plan.json
node dist/src/cli.js register ../data/plan.json --dry-run
DEPSPLIT_REGISTRY=test/fixtures/registry.json USDC_CONTRACT_ID=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
  node dist/src/cli.js pay quickparse 5000 --memo "Q3 dependency fund - quickparse" --dry-run
node dist/src/cli.js statement GBJIDJ5RLIRCNK5A5YOKUYABRDUWGSCRJXSIZHWXKMN6YFGSH4XHEUHD \
     --payments ../data/seed/payments.csv --registry test/fixtures/registry.json
```

Expected output for each step is in [DEMO.md](DEMO.md). `scripts/build.sh` runs all of the above.

### Against testnet (not executed here)

`scripts/deploy-testnet.sh` generates and funds identities with Friendbot, deploys the wasm,
derives the USDC Stellar Asset Contract id and registers the three seed projects with
`stellar contract invoke`. Then set the variables from `.env.example` and use the CLI without
`--dry-run`. The build environment could not reach testnet RPC, Horizon or Friendbot, so none of
this was run; see `TOOLCHAIN.md`.

## CLI reference

```
depsplit import <funding.json>... [--out plan.json]      parse manifests -> register plan (offline)
depsplit register <plan.json> [--dry-run]                register in dependency order (owner signs)
depsplit update-splits <plan.json> <slug> [--dry-run]    new table version (owner signs) -> version+1
depsplit pay <slug|id> <amount> --memo "<text>" [--dry-run]   payer signs; appends to the payments log
depsplit distribute <slug|id> [--dry-run]                split a project's pool one hop (anyone)
depsplit withdraw [--to G...] [--dry-run]                recipient signs; pulls the whole balance
depsplit statement <payer> [--payments f] [--registry f] [--out f.csv]
depsplit project <slug|id> | balance <addr> | pool <slug|id>
```

Amounts are decimal USDC with up to 7 decimals; the CLI and contract work in stroops.
`--memo` text is hashed (sha256) into the 32-byte `memo_hash` carried by the `pay` event, and the
plain text stays in the payer's local `payments.csv` so the statement can show it.

### `funding.json` extension

DepSplit reads the FLOSS/fund manifest subset `version`, `entity`, `projects[]` and adds one block
per project (or a top-level default `owner`):

```json
"x-stellar": {
  "owner": "G...",
  "maintainers": [ { "address": "G...", "bps": 4500, "name": "...", "note": "..." } ],
  "dependencies": [ { "slug": "bufring", "bps": 3000 } ]
}
```

`import` validates exactly what the contract validates (sum 10 000, no zero or duplicate shares,
no self-dependency, valid addresses, slug format) and reports every problem at once; messy but
recoverable input (trailing spaces, uppercase guids, bps given as strings) is normalised with a
warning. Dependencies are ordered so that a dependency is always registered before its dependants.

## Cash-out: SEP-24 anchor handoff (documented, no anchor code in this repo)

The contract's job ends when a maintainer's USDC is in their own Stellar account. Turning it into
local currency is the anchor's job, and it is a standard flow that any SEP-24 wallet already
implements, so DepSplit only documents the handoff:

1. **Withdraw** with `depsplit withdraw` (the maintainer's account needs a USDC trustline; the
   pull model means a missing trustline never breaks anyone's payment, the balance just waits).
2. **Pick an anchor** that serves the maintainer's country and lists USDC withdrawals in its
   `https://<anchor-domain>/.well-known/stellar.toml` (`TRANSFER_SERVER_SEP0024`, `CURRENCIES`).
   The Stellar anchor directory and MoneyGram Access (cash pickup) are the starting points.
3. **Start the interactive withdrawal** from any SEP-24 wallet: the wallet authenticates with SEP-10,
   calls `POST <TRANSFER_SERVER_SEP0024>/transactions/withdraw/interactive` with
   `asset_code=USDC` and the maintainer's account, and receives
   `{ "type": "interactive_customer_info_needed", "url": "https://<anchor>/...?token=...", "id": "..." }`.
   The maintainer opens that URL, completes the anchor's KYC and enters bank or mobile-money details.
4. **Fund the withdrawal.** The anchor's `GET /transaction?id=...` moves to
   `pending_user_transfer_start` and returns `withdraw_anchor_account`, `withdraw_memo` and
   `withdraw_memo_type`. The wallet sends the USDC there, which is the SEP-7 link format a wallet or
   the CLI can hand over:

   ```
   web+stellar:pay?destination=<withdraw_anchor_account>&amount=<usdc>&asset_code=USDC
        &asset_issuer=<issuer>&memo=<withdraw_memo>&memo_type=<withdraw_memo_type>
   ```
5. The anchor pays out in local currency; the transaction status becomes `completed`.

What DepSplit does not do: choose the anchor, run KYC, hold funds after `withdraw`, or take a fee.
The success metric in [VALIDATION.md](VALIDATION.md) counts the anchor fee as part of the total.

## Repository layout

```
stellar/depsplit/
  Cargo.toml                 workspace (members = contracts/*), release profile from CONTRIBUTING.md
  contracts/split_router/    Soroban contract + tests + test_snapshots/
  app/                       TypeScript CLI (@stellar/stellar-sdk 17), node:test suite, fixtures
  data/seed/                 three funding.json manifests + payments.csv
  scripts/                   build.sh, deploy-testnet.sh (not executed here)
  ARCHITECTURE.md  VALIDATION.md  DEMO.md  .env.example
```

## Status

**functional locally** (contract executed in the Soroban host via `cargo test`, wasm built,
offline CLI tests pass); deployment scripts are **testnet-ready** but were not executed in this
environment. No users, no deployment, no measurements yet.
