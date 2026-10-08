//! DepSplit `split_router`
//!
//! Dependency-aware payout splits for open-source projects.
//!
//! A project owner registers a split table: maintainers (Stellar addresses with
//! basis-point shares) and dependencies (other registered projects with basis-point
//! shares). The table must sum to exactly 10_000 bps. A payer calls `pay` once;
//! the tokens move into this contract and are *credited* (not pushed):
//!
//! * each maintainer's `balance[(token, addr)]` grows by `amount * bps / 10_000`;
//! * each dependency project's `pool[(token, dep_id)]` grows by its share;
//! * the rounding remainder ("dust") is credited to the project owner.
//!
//! Dependencies are settled **one hop at a time**: `pay` credits the dependency's
//! pool, it does not re-split it. Anyone may later call `distribute_pool` on that
//! dependency, which applies *that* project's current table (again one hop). A
//! chain A -> B -> C is therefore settled by `pay(A)`, `distribute_pool(B)`,
//! `distribute_pool(C)`. This keeps every call bounded, makes cycles harmless
//! (each hop only ever moves value forward and rounds down) and lets each project
//! keep full control over how its own share is divided.
//!
//! Withdrawals are a **pull model**: `withdraw(token, to)` transfers the accrued
//! balance to `to`. A recipient that has no trustline yet can never make a
//! payment fail; they simply withdraw later.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, String, Vec,
};

/// Basis points in a whole split table.
pub const BPS_DENOMINATOR: u32 = 10_000;
/// Upper bound on maintainers per table (keeps `pay` gas bounded).
pub const MAX_MAINTAINERS: u32 = 32;
/// Upper bound on dependencies per table.
pub const MAX_DEPENDENCIES: u32 = 32;
/// Upper bound on slug length in bytes.
pub const MAX_SLUG_LEN: u32 = 64;

// ---------------------------------------------------------------------------
// TTL policy (ledgers; ~5 s each, so 17_280 per day).
// Project tables and slug index: extended to ~180 days whenever touched.
// Balances and pools: extended to ~120 days whenever touched. A balance that is
// neither credited nor withdrawn for 120 days is archived, not lost: it can be
// restored with a RestoreFootprint operation before withdrawing (see ARCHITECTURE.md).
// ---------------------------------------------------------------------------
const DAY_IN_LEDGERS: u32 = 17_280;
const PROJECT_TTL: u32 = 180 * DAY_IN_LEDGERS;
const PROJECT_TTL_THRESHOLD: u32 = PROJECT_TTL - 30 * DAY_IN_LEDGERS;
const BALANCE_TTL: u32 = 120 * DAY_IN_LEDGERS;
const BALANCE_TTL_THRESHOLD: u32 = BALANCE_TTL - 30 * DAY_IN_LEDGERS;
const INSTANCE_TTL: u32 = 180 * DAY_IN_LEDGERS;
const INSTANCE_TTL_THRESHOLD: u32 = INSTANCE_TTL - 30 * DAY_IN_LEDGERS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A maintainer share of a project's table.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Share {
    pub addr: Address,
    pub bps: u32,
}

/// A dependency share of a project's table: credited to that project's pool.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepShare {
    pub project_id: u32,
    pub bps: u32,
}

/// A registered project and its current split table.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Project {
    pub id: u32,
    pub owner: Address,
    pub slug: String,
    /// Starts at 1; incremented by every `update_splits`.
    pub version: u32,
    pub maintainers: Vec<Share>,
    pub dependencies: Vec<DepShare>,
    /// Inactive projects reject `pay` and `distribute_pool` until reactivated.
    pub active: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: next project id to assign (ids start at 1).
    NextId,
    /// Persistent: project id -> Project.
    Project(u32),
    /// Persistent: slug -> project id (uniqueness index).
    Slug(String),
    /// Persistent: (token, recipient) -> withdrawable amount.
    Balance(Address, Address),
    /// Persistent: (token, project id) -> undistributed pool.
    Pool(Address, u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// maintainer bps + dependency bps != 10_000
    SplitSumMismatch = 1,
    /// a table must have at least one maintainer
    NoMaintainers = 2,
    /// every share must be > 0 bps
    ZeroBps = 3,
    DuplicateMaintainer = 4,
    DuplicateDependency = 5,
    DependencyNotFound = 6,
    SelfDependency = 7,
    ProjectNotFound = 8,
    /// amount must be > 0
    InvalidAmount = 9,
    ProjectInactive = 10,
    /// checked arithmetic overflowed (i128)
    Overflow = 11,
    NothingToWithdraw = 12,
    EmptyPool = 13,
    SlugTaken = 14,
    /// slug empty or longer than MAX_SLUG_LEN
    InvalidSlug = 15,
    TooManyShares = 16,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent(topics = ["depsplit", "register"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectRegistered {
    #[topic]
    pub id: u32,
    pub owner: Address,
    pub slug: String,
    pub version: u32,
}

#[contractevent(topics = ["depsplit", "update"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SplitsUpdated {
    #[topic]
    pub id: u32,
    pub version: u32,
}

#[contractevent(topics = ["depsplit", "active"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveChanged {
    #[topic]
    pub id: u32,
    pub active: bool,
}

#[contractevent(topics = ["depsplit", "pay"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Paid {
    #[topic]
    pub id: u32,
    #[topic]
    pub from: Address,
    pub token: Address,
    pub amount: i128,
    pub memo_hash: BytesN<32>,
    /// table version the payment was split with
    pub version: u32,
    /// rounding remainder credited to the project owner
    pub dust: i128,
}

#[contractevent(topics = ["depsplit", "distribute"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolDistributed {
    #[topic]
    pub id: u32,
    pub token: Address,
    pub amount: i128,
    pub version: u32,
    pub dust: i128,
}

#[contractevent(topics = ["depsplit", "withdraw"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub to: Address,
    pub token: Address,
    pub amount: i128,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct SplitRouter;

#[contractimpl]
impl SplitRouter {
    /// Register a project with its first split table (version 1). Returns the new id.
    ///
    /// `owner` must authorize. Every dependency must already be registered (so a
    /// project can never depend on itself at registration; cycles can only be
    /// created later through `update_splits`, and are harmless because
    /// distribution is one hop per call).
    pub fn register_project(
        env: Env,
        owner: Address,
        slug: String,
        maintainers: Vec<Share>,
        dependencies: Vec<DepShare>,
    ) -> Result<u32, Error> {
        owner.require_auth();
        extend_instance(&env);

        let slug_len = slug.len();
        if slug_len == 0 || slug_len > MAX_SLUG_LEN {
            return Err(Error::InvalidSlug);
        }
        let slug_key = DataKey::Slug(slug.clone());
        if env.storage().persistent().has(&slug_key) {
            return Err(Error::SlugTaken);
        }

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u32);
        validate_table(&env, id, &maintainers, &dependencies)?;

        let next = id.checked_add(1).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::NextId, &next);

        let project = Project {
            id,
            owner: owner.clone(),
            slug: slug.clone(),
            version: 1,
            maintainers,
            dependencies,
            active: true,
        };
        put_project(&env, &project);
        env.storage().persistent().set(&slug_key, &id);
        env.storage()
            .persistent()
            .extend_ttl(&slug_key, PROJECT_TTL_THRESHOLD, PROJECT_TTL);

        ProjectRegistered {
            id,
            owner,
            slug,
            version: 1,
        }
        .publish(&env);
        Ok(id)
    }

    /// Replace a project's table. Owner must authorize. Bumps `version` by one.
    ///
    /// Balances and pools already credited are untouched: only payments and
    /// distributions after this call use the new table.
    pub fn update_splits(
        env: Env,
        id: u32,
        maintainers: Vec<Share>,
        dependencies: Vec<DepShare>,
    ) -> Result<u32, Error> {
        let mut project = get_project(&env, id)?;
        project.owner.require_auth();
        extend_instance(&env);

        validate_table(&env, id, &maintainers, &dependencies)?;
        let version = project.version.checked_add(1).ok_or(Error::Overflow)?;
        project.version = version;
        project.maintainers = maintainers;
        project.dependencies = dependencies;
        put_project(&env, &project);

        SplitsUpdated { id, version }.publish(&env);
        Ok(version)
    }

    /// Pause or resume a project. Owner must authorize. While inactive the
    /// project rejects `pay` and `distribute_pool`; funds already credited to
    /// maintainer balances remain withdrawable, and payments to *other* projects
    /// that list this one as a dependency keep accruing to its pool.
    pub fn set_active(env: Env, id: u32, active: bool) -> Result<(), Error> {
        let mut project = get_project(&env, id)?;
        project.owner.require_auth();
        extend_instance(&env);
        if project.active != active {
            project.active = active;
            put_project(&env, &project);
            ActiveChanged { id, active }.publish(&env);
        }
        Ok(())
    }

    /// Pay a project. `from` must authorize; `amount` of `token` moves from `from`
    /// into this contract and is credited according to the project's current
    /// table (one hop: dependency shares land in their pools). `memo_hash` is an
    /// opaque 32-byte reference (for example sha256 of the payer's invoice id)
    /// carried in the event for the payer's books.
    pub fn pay(
        env: Env,
        id: u32,
        from: Address,
        token: Address,
        amount: i128,
        memo_hash: BytesN<32>,
    ) -> Result<(), Error> {
        from.require_auth();
        extend_instance(&env);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let project = get_project(&env, id)?;
        if !project.active {
            return Err(Error::ProjectInactive);
        }

        token::TokenClient::new(&env, &token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        let dust = credit_table(&env, &project, &token, amount)?;
        Paid {
            id,
            from,
            token,
            amount,
            memo_hash,
            version: project.version,
            dust,
        }
        .publish(&env);
        Ok(())
    }

    /// Split a project's accumulated pool of `token` to its *current* table.
    /// Anyone may call this (no auth: it can only move value in the direction
    /// the owner already declared). One hop: dependency shares land in their
    /// pools, so a chain is settled by calling this once per project down the
    /// chain. Returns the amount distributed.
    pub fn distribute_pool(env: Env, id: u32, token: Address) -> Result<i128, Error> {
        extend_instance(&env);
        let project = get_project(&env, id)?;
        if !project.active {
            return Err(Error::ProjectInactive);
        }
        let key = DataKey::Pool(token.clone(), id);
        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount <= 0 {
            return Err(Error::EmptyPool);
        }
        // Zero the pool before crediting so a dependency cycle back to this
        // project lands in a fresh pool rather than being double counted.
        env.storage().persistent().set(&key, &0i128);
        env.storage()
            .persistent()
            .extend_ttl(&key, BALANCE_TTL_THRESHOLD, BALANCE_TTL);

        let dust = credit_table(&env, &project, &token, amount)?;
        PoolDistributed {
            id,
            token,
            amount,
            version: project.version,
            dust,
        }
        .publish(&env);
        Ok(amount)
    }

    /// Withdraw the whole accrued balance of `token` for `to`. `to` must
    /// authorize. Pull model: nothing is ever pushed to an address, so an
    /// address without a trustline can never break a payment. Returns the amount.
    pub fn withdraw(env: Env, token: Address, to: Address) -> Result<i128, Error> {
        to.require_auth();
        extend_instance(&env);
        let key = DataKey::Balance(token.clone(), to.clone());
        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount <= 0 {
            return Err(Error::NothingToWithdraw);
        }
        env.storage().persistent().set(&key, &0i128);
        env.storage()
            .persistent()
            .extend_ttl(&key, BALANCE_TTL_THRESHOLD, BALANCE_TTL);

        token::TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        Withdrawn { to, token, amount }.publish(&env);
        Ok(amount)
    }

    // ----- views -----------------------------------------------------------

    /// Withdrawable balance of `token` for `addr`.
    pub fn balance(env: Env, token: Address, addr: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(token, addr))
            .unwrap_or(0)
    }

    /// Undistributed pool of `token` credited to project `id`.
    pub fn pool(env: Env, token: Address, id: u32) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Pool(token, id))
            .unwrap_or(0)
    }

    /// The project and its current table.
    pub fn project(env: Env, id: u32) -> Result<Project, Error> {
        get_project(&env, id)
    }

    /// Look a project id up by slug.
    pub fn project_id_by_slug(env: Env, slug: String) -> Option<u32> {
        env.storage().persistent().get(&DataKey::Slug(slug))
    }

    /// Number of registered projects (ids run 1..=count).
    pub fn project_count(env: Env) -> u32 {
        let next: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u32);
        next - 1
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL);
}

fn get_project(env: &Env, id: u32) -> Result<Project, Error> {
    let key = DataKey::Project(id);
    let project: Project = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::ProjectNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, PROJECT_TTL_THRESHOLD, PROJECT_TTL);
    Ok(project)
}

fn put_project(env: &Env, project: &Project) {
    let key = DataKey::Project(project.id);
    env.storage().persistent().set(&key, project);
    env.storage()
        .persistent()
        .extend_ttl(&key, PROJECT_TTL_THRESHOLD, PROJECT_TTL);
}

/// Validate a split table for project `self_id`:
/// at least one maintainer, bounded sizes, no zero shares, no duplicates, no
/// self-dependency, every dependency registered, and bps summing to exactly 10_000.
fn validate_table(
    env: &Env,
    self_id: u32,
    maintainers: &Vec<Share>,
    dependencies: &Vec<DepShare>,
) -> Result<(), Error> {
    if maintainers.is_empty() {
        return Err(Error::NoMaintainers);
    }
    if maintainers.len() > MAX_MAINTAINERS || dependencies.len() > MAX_DEPENDENCIES {
        return Err(Error::TooManyShares);
    }
    let mut total: u32 = 0;
    for (i, m) in maintainers.iter().enumerate() {
        if m.bps == 0 {
            return Err(Error::ZeroBps);
        }
        for j in 0..i {
            if maintainers.get_unchecked(j as u32).addr == m.addr {
                return Err(Error::DuplicateMaintainer);
            }
        }
        total = total.checked_add(m.bps).ok_or(Error::Overflow)?;
    }
    for (i, d) in dependencies.iter().enumerate() {
        if d.bps == 0 {
            return Err(Error::ZeroBps);
        }
        if d.project_id == self_id {
            return Err(Error::SelfDependency);
        }
        for j in 0..i {
            if dependencies.get_unchecked(j as u32).project_id == d.project_id {
                return Err(Error::DuplicateDependency);
            }
        }
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Project(d.project_id))
        {
            return Err(Error::DependencyNotFound);
        }
        total = total.checked_add(d.bps).ok_or(Error::Overflow)?;
    }
    if total != BPS_DENOMINATOR {
        return Err(Error::SplitSumMismatch);
    }
    Ok(())
}

/// `amount * bps / 10_000`, rounded down, overflow-checked.
fn share_of(amount: i128, bps: u32) -> Result<i128, Error> {
    amount
        .checked_mul(bps as i128)
        .ok_or(Error::Overflow)
        .map(|v| v / BPS_DENOMINATOR as i128)
}

fn add_to(env: &Env, key: &DataKey, delta: i128) -> Result<(), Error> {
    let current: i128 = env.storage().persistent().get(key).unwrap_or(0);
    let next = current.checked_add(delta).ok_or(Error::Overflow)?;
    env.storage().persistent().set(key, &next);
    env.storage()
        .persistent()
        .extend_ttl(key, BALANCE_TTL_THRESHOLD, BALANCE_TTL);
    Ok(())
}

/// Credit `amount` of `token` according to `project`'s table, one hop.
/// Returns the dust credited to the owner. Conservation: the sum of all
/// credits (maintainers + pools + dust) equals `amount` exactly.
fn credit_table(env: &Env, project: &Project, token: &Address, amount: i128) -> Result<i128, Error> {
    let mut credited: i128 = 0;
    for m in project.maintainers.iter() {
        let part = share_of(amount, m.bps)?;
        if part > 0 {
            add_to(env, &DataKey::Balance(token.clone(), m.addr.clone()), part)?;
        }
        credited = credited.checked_add(part).ok_or(Error::Overflow)?;
    }
    for d in project.dependencies.iter() {
        let part = share_of(amount, d.bps)?;
        if part > 0 {
            add_to(env, &DataKey::Pool(token.clone(), d.project_id), part)?;
        }
        credited = credited.checked_add(part).ok_or(Error::Overflow)?;
    }
    let dust = amount.checked_sub(credited).ok_or(Error::Overflow)?;
    if dust > 0 {
        add_to(
            env,
            &DataKey::Balance(token.clone(), project.owner.clone()),
            dust,
        )?;
    }
    Ok(dust)
}

#[cfg(test)]
mod test;
