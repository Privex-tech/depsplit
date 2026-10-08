# DepSplit validation

Evidence is separated by tier, as required by `CONTRIBUTING.md`. Nothing below claims a user,
a deployment or a measurement that did not happen.

## 1. Researched evidence (from the monorepo research dossiers)

From `research/05-problems-infra-data-ai-climate.md`, problem **P1** ("Open-source maintainers who
cannot legally receive money through GitHub Sponsors"):

- GitHub Sponsors pays through Stripe Connect Express and covers roughly **70 countries**, excluding
  large parts of Asia, Africa, the Middle East and Eastern Europe (verified via donatr.ee excerpt).
- A Bangladesh applicant has been on the waiting list "for years"; GitHub cannot expedite unsupported
  regions (verified-fetch: `https://github.com/orgs/community/discussions/175076`).
- **124 days** with no payout; a second maintainer ~$1,000 unpaid after **88 days** (June-Sept 2026);
  Stripe confirmed the payout was "manually configured and awaiting GitHub's trigger"
  (verified-fetch: `https://github.com/orgs/community/discussions/180328`).
- Algora settles bounties by bank transfer in **23 countries / 33 currencies**, requires Stripe
  Express KYC and charges organisations **9%** (verified: `https://gigs.sh/p/algora`).
- Open Collective fiscal hosts take ~10% and still pay via Stripe/PayPal/Wise [estimate].
- Drips Network (Ethereum) already funds dependencies and is used by SDF's "Drips Wave" programme
  for Stellar repos; Gitcoin Grants Stack/Allo entered maintenance mode in May 2025; every web3
  option pays into an EVM wallet with no local-currency exit (P1, "Existing alternatives").

From **P2** ("Bounty escrow and payout to the right contributor"): typical 2026 awards are
$50-$2,500, 9% fee, 23 payout countries; existing Soroban bounty/escrow repos have 0 stars and no
org-side adoption; none solves the geography of the payout. P2 is recorded as the expansion path
(a bounty is a one-off payment with a single-recipient table), not as MVP scope.

From `research/08-final-selection.md` section 03: the user (maintainer in Bangladesh/Nigeria/
Pakistan/Vietnam as payee; OSPO/foundation programme manager as payer), the buyer (foundations,
OSPOs, companies with dependency budgets; SDF runs a contributor-rewards programme on Drips), and the
risks (maintainers need a wallet and an anchor in their country; payers may want fiat invoicing).

## 2. Observed facts (this build, this environment)

- `cargo test`: 18 tests pass in the Soroban host (real auth, storage and token semantics), including
  `scenario_three_projects` and a 60-iteration property test over random tables and amounts.
- `stellar contract build`: `split_router.wasm`, 15,864 bytes, target `wasm32v1-none`.
- `npm test`: 22 offline tests pass (funding.json parsing incl. an invalid file, bps validation,
  register-plan ordering and cycle detection, statement CSV shape, split-maths mirror, transaction
  building, CLI argument parsing).
- The CLI's `import` handles the three seed manifests and reports every problem in the invalid fixture
  in one pass (exit code 1); `statement` reproduces the contract's split lines to the stroop.
- Testnet RPC, Horizon and Friendbot were **unreachable** from the build sandbox; the deploy script was
  written against stellar-cli 28 documentation and **not executed**.

## 3. Team assumptions

- Foundations and OSPOs will accept "pay one address, the table does the rest" as a procurement
  model, and will pay in USDC on Stellar (or through an on-ramp that produces it).
- Maintainers in excluded countries can obtain a Stellar wallet and reach at least one SEP-24 anchor
  or MoneyGram Access location; anchor fees plus the network fee stay under 1% for amounts in the
  $100-$5,000 range.
- One hop per distribution call is acceptable because settlement can be run by anyone, including a
  scheduled job the payer or foundation operates.
- Rounding dust to the project owner is acceptable to maintainers (it is at most `shares - 1`
  stroops per payment).

## 4. Hypotheses

- H1: A maintainer in an unsupported country who receives a DepSplit credit has cash in local
  currency within 1 day of withdrawing, versus 88-124+ days (or never) through Sponsors.
- H2: Total cost (network fees + anchor fee) is below 1% of the amount for payments of $100 or more,
  versus 9-10% on Algora/Open Collective.
- H3: A payer with a dependency budget prefers one payment plus an auditable table to N separate
  vendor onboardings, and will use the statement CSV in their books without manual re-entry.
- H4: Downstream projects (dependencies) notice and register once an upstream project routes money to
  them, creating pull for the manifests.

## 5. Simulated / demo data

`data/seed/`: three FLOSS/fund manifests (`quickparse` -> `utf8-guard` -> `bufring`, plus
`quickparse-cli`), fictional projects and maintainers with realistic noise (uppercase guid, bps as a
string, trailing spaces, email casing, a 3333/3333/3334 split), one maintainer noted as living in
Bangladesh outside Stripe's payout list, and `payments.csv` with thousands separators, quoted memos,
a typo'd slug and an over-precise amount. The Rust scenario pays 5,000 and 1,000 USDC from a
foundation and a messy 1,234.5678901 USDC from a company under a re-versioned table. None of these
are real payments.

## 6. Actual validation

**None yet.** No maintainer, foundation or anchor has used the system. No interviews were run in this
build environment.

## Baseline and success metric

| | Baseline (researched) | Target | How measured |
|---|---|---|---|
| Payout reach | ~70 countries (Sponsors), 23 (Algora) | any non-sanctioned country with an anchor | count of countries of paid maintainers in the pilot |
| Time to cash | 88-124+ days, or indefinite "pending" | < 1 day from `withdraw` to local currency | timestamps: `pay` event -> `withdraw` event -> anchor `completed` |
| Fee | 9% (Algora), ~10% (Open Collective) | < 1% including the anchor | (amount paid - amount received in local currency at mid-market) / amount paid |

## Experiment plan: the 10-maintainer cohort

1. Recruit 10 maintainers from the GitHub community discussions cited above (175076, 180328) and
   similar threads, prioritising Bangladesh, Nigeria, Pakistan, Egypt and Vietnam.
2. Each publishes a `funding.json` with the `x-stellar` block; we import and register the tables on
   testnet first, then mainnet.
3. One foundation (or a sponsor acting as one) pays a $1-5k monthly cohort through the router for
   two cycles; dependency tables are encouraged but not required.
4. Measure per maintainer: time from `pay` to `withdraw`, time from `withdraw` to anchor
   `completed`, total fee, number of support interactions, whether they chose to leave funds parked.
5. Measure for the payer: minutes spent per cycle, whether the statement CSV was imported into their
   books unchanged.
6. Stop rule: if fewer than 6 of 10 maintainers can find a working anchor in their country, the
   exit assumption is false and the project pivots to a fiscal-sponsor pilot or stops.

## Killer questions

1. **Would the user care if it disappeared?** Unknown: no users. The pain (income foregone for
   years) is documented, so a working exit should be missed; the pilot measures it.
2. **Did anyone outside the team use it?** No.
3. **Before/after measured?** No. Baseline numbers are researched (88-124 days, ~70 countries, 9%);
   the "after" needs the pilot.
4. **Value lost without AI?** None: there is no AI in this project, by design.
5. **Reason to keep using after the demo?** Recurring monthly payouts and every new sponsor; the
   table and the statement make the second payment cheaper than the first.
6. **Would someone pay?** Foundations and OSPOs are the plausible buyer (a flat fee per payer or 1%
   on flow); thin fees cap upside. Not tested.
7. **Does the chain create value?** Yes for this user: an immutable, auditable table, settlement to
   any wallet without a platform deciding who is allowed to be paid, and composable funding across
   projects. It adds nothing for a maintainer in a Stripe country who is happy with Sponsors.
8. **Why this chain?** Native USDC, SEP-24/SEP-31 anchors and MoneyGram Access for the exit,
   sub-cent fees on many small shares, and SDF's existing contributor-rewards precedent; Drips on EVM
   already exists and does not solve the exit (see ARCHITECTURE.md).
