# DepSplit architecture

## Components

```
 funding.json (x3)          payer's books
      |                          ^
      v  import                  |  statement (CSV)
 +-----------+   register/pay/   +-----------+        +----------------------+
 |  depsplit |  distribute/      | registry  |        |  split_router (wasm) |
 |    CLI    |  withdraw  ------ | payments  |        |  projects, balances, |
 |  (Node)   | ---- Soroban RPC -------------------->  |  pools, events       |
 +-----------+                                         +----------+-----------+
                                                                  |  USDC (SEP-41 token)
                                                                  v
                          maintainer wallet  --withdraw-->  own account  --SEP-24-->  anchor  -->  bank / mobile money
```

- **`split_router`** (Rust, `soroban-sdk 28`): the only trusted component. Holds the tables, the
  credited balances and the undistributed pools, and custodies the USDC between `pay` and `withdraw`.
- **CLI** (`app/`): stateless except for two local files. `data/registry.json` caches slug -> id
  and every table version (so dependency slugs resolve and statements can mirror the exact table a
  payment used). `data/payments.csv` is the payer's own log, appended by `pay`.
- **Anchor** (not in this repo): the SEP-24 cash-out described in README.

## Contract interface

| Function | Auth | Effect | Errors |
|---|---|---|---|
| `register_project(owner, slug, maintainers, dependencies) -> id` | `owner` | validates the table, assigns the next id, stores version 1, indexes the slug | `InvalidSlug`, `SlugTaken`, table errors below |
| `update_splits(id, maintainers, dependencies) -> version` | project owner | replaces the table, `version += 1`; balances/pools untouched | `ProjectNotFound`, table errors |
| `set_active(id, active)` | project owner | pause/resume: inactive projects reject `pay` and `distribute_pool` | `ProjectNotFound` |
| `pay(id, from, token, amount, memo_hash)` | `from` | `token.transfer(from -> contract, amount)`, then one-hop credit | `InvalidAmount`, `ProjectNotFound`, `ProjectInactive`, `Overflow`, token failures |
| `distribute_pool(id, token) -> amount` | none | zeroes `pool[(token,id)]` and credits it through the project's **current** table, one hop | `ProjectNotFound`, `ProjectInactive`, `EmptyPool`, `Overflow` |
| `withdraw(token, to) -> amount` | `to` | zeroes `balance[(token,to)]`, `token.transfer(contract -> to)` | `NothingToWithdraw` |
| `balance(token, addr)`, `pool(token, id)`, `project(id)`, `project_id_by_slug(slug)`, `project_count()` | none | views | `ProjectNotFound` (project) |

Table errors: `SplitSumMismatch` (sum != 10 000), `NoMaintainers`, `ZeroBps`, `DuplicateMaintainer`,
`DuplicateDependency`, `DependencyNotFound`, `SelfDependency`, `TooManyShares` (> 32 of either kind).

Events (`#[contractevent]`, topics `("depsplit", <name>, ...)`): `register(id)`, `update(id)`,
`active(id)`, `pay(id, from)` with `token, amount, memo_hash, version, dust`, `distribute(id)` with
`token, amount, version, dust`, `withdraw(to)` with `token, amount`. The `version` on `pay` and
`distribute` is what a statement generator needs to reproduce the split lines exactly.

### Credit algorithm (`credit_table`)

```
for m in maintainers:   balance[(token, m.addr)]        += amount * m.bps / 10_000   (floor)
for d in dependencies:  pool[(token, d.project_id)]     += amount * d.bps / 10_000   (floor)
dust = amount - sum(shares)          # 0 <= dust < number of shares
balance[(token, owner)] += dust
```

All arithmetic is `i128` with `checked_mul`/`checked_add`; any overflow aborts the call with
`Error::Overflow` and, because a Soroban contract error rolls back the whole invocation including
the sub-invoked token transfer, the payer keeps their funds (tested in
`pay_overflow_is_rejected_atomically`). The invariant *sum of credits == amount* is checked by a
property-style test over random tables and amounts, and the global invariant *contract token
balance == sum of all balances + pools* is asserted after every scenario.

## Storage and TTL

| Key | Type | Value | TTL policy |
|---|---|---|---|
| `NextId` | instance | next project id | instance extended to ~180 days on every write |
| `Project(id)` | persistent | `Project` struct | extended to ~180 days whenever read or written |
| `Slug(slug)` | persistent | `u32` id | ~180 days, extended on registration |
| `Balance(token, addr)` | persistent | `i128` | ~120 days, extended on every credit or withdrawal |
| `Pool(token, id)` | persistent | `i128` | ~120 days, extended on every credit or distribution |

Archival: a persistent entry whose TTL lapses is archived, not deleted. A balance that was neither
credited nor withdrawn for ~120 days can be brought back with a `RestoreFootprint` operation before
`withdraw` (the CLI does not automate this yet; stellar-cli's `contract restore` does). Project
tables are touched by every `pay`, so an active project never lapses; a dormant one is restored the
same way. Thresholds (30 days before expiry) keep the extension fee from being paid on every call.

## Design decisions

### Pull model for withdrawals

`pay` never transfers to a recipient. It credits an internal balance; the recipient calls
`withdraw` when they want the funds. Reasons:

- **A recipient without a USDC trustline cannot break a payment.** With push transfers, one
  maintainer who has not set up a trustline (or whose account does not exist yet) would make the
  whole `pay` fail, and the payer would have to chase them. With pull, the payer's transaction always
  succeeds and each maintainer's balance waits.
- **Bounded cost per `pay`.** Crediting is a storage write per share; transferring would be a
  sub-invocation per share plus every recipient's trustline in the footprint.
- **Privacy and timing.** Maintainers in countries with volatile local currencies can choose when to
  cash out; the on-chain record shows the credit, the withdrawal and nothing about the anchor.

Cost: the recipient pays one transaction fee (fractions of a cent) to withdraw, and funds sit in
the contract until then (see TTL above).

### One hop per call

A payment to `quickparse` credits `utf8-guard`'s and `bufring`'s **pools**; it does not re-split
them. `distribute_pool(utf8-guard)` then applies utf8-guard's own table, sending 30% to bufring's
pool, and `distribute_pool(bufring)` finishes the chain.

- **Bounded, predictable gas.** A recursive split over a dependency graph is unbounded work inside
  one transaction and would let a deep or wide graph make paying a popular project impossible.
- **Cycles are harmless.** `update_splits` can create a cycle (A <-> B). Each hop rounds down and
  moves value forward, so repeated distribution converges: the tail becomes dust for the owners
  (tested in `dependency_cycle_created_by_update_terminates_under_repeated_distribution`).
- **Each project controls its own share.** A dependency's pool is split by *that* project's current
  table, not by whatever table existed when the upstream payment happened. If bufring re-versions
  between the payment and the distribution, the new table applies
  (`distribute_pool_uses_the_current_table_version`).
- **Anyone can settle.** `distribute_pool` needs no authorization because it can only move value
  along a path the owner already declared. A payer, a maintainer, or a scheduled job can call it;
  the CLI reminds the caller to continue down the chain.

Trade-off: a chain of *n* dependencies needs *n* calls; until they happen, the money sits in
pools rather than balances. The pool is visible (`pool(token, id)`) and the `distribute` event records
each settlement.

### Versioning

`update_splits` replaces the table and increments `version`. Nothing already credited changes:
balances and pools are plain numbers, not references to a table. Every `pay` and `distribute` event
carries the version it used, and the CLI's registry stores every version so `statement` mirrors the
exact split of each historical payment. The owner cannot claw back or redirect credited funds; they
can only change how *future* amounts split. `set_active(false)` is the "pause" switch while a table is
being fixed: it rejects new payments and pool distributions, never withdrawals.

### Rounding

Shares round down; the remainder (at most `shares - 1` stroops) goes to the project owner's balance.
This keeps the contract free of a "who gets the last stroop" rule per maintainer and makes the
accounting identity exact. The statement shows it as a `dust` line.

## Trust assumptions and limits

- The project owner key is the only authority over a table. There is no multisig or timelock in the
  contract; owners who want one can use a Stellar account with multisig thresholds as `owner`.
- The contract holds custody between `pay` and `withdraw`. It has no admin, no upgrade hook and no
  way to move funds except through the credited balances; a bug is therefore permanent for a
  deployment (a new deployment with new ids would be needed).
- `pay` accepts any SEP-41 token; balances and pools are keyed by token, but the CLI defaults to a
  single `USDC_CONTRACT_ID`. Tokens with transfer fees or rebasing would break the identity
  *held == owed* and are out of scope.
- Slugs are unique per deployment and never change; owners rename by registering a new project.
- Limits: 32 maintainers and 32 dependencies per table, slugs up to 64 bytes.
- The CLI's statement is built from the payer's local log plus the registry, not from on-chain
  events. Reconciling against `getEvents` is future work; the event payloads already contain
  everything needed.
- No fee is taken by the contract. Commercial options (flat fee per payer, or a bps line in the table
  pointing at the operator) do not require contract changes: a fee is just another `Share`.

## Why Stellar, and why not Drips on an EVM chain

Drips (Ethereum, Optimism, Filecoin) already implements dependency-aware splits with a richer model
(continuous streams, arbitrary depth via off-chain settlement). DepSplit deliberately does less on
the contract side and more on the exit side, because the exit is what fails for the target user:

| | Drips on EVM | DepSplit on Stellar |
|---|---|---|
| Money in | ETH/ERC-20, gas per split can be dollars | USDC Stellar Asset Contract, fees in fractions of a cent, so a $250 monthly plan split six ways still makes sense |
| Money out | CEX or a bridge; no regulated local off-ramp for Dhaka, Lagos, Karachi | SEP-24/SEP-31 anchors and MoneyGram Access: regulated cash-out in local currency, one interactive flow from any wallet |
| Split depth | recursive, settled by off-chain cycles/drivers | one hop per call, settled on-chain by anyone |
| Table changes | stream-based, continuous | explicit versions, every event tagged with the version used |
| Ecosystem fit | Ethereum public goods funding | SDF already rewards Stellar contributors through Drips Wave; a native router closes the loop on the chain where the funds and the exit live |

The contract is small on purpose: the value is USDC that a maintainer in an unsupported country can
turn into cash this week, with a table the payer can audit.
