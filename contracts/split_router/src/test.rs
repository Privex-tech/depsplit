#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::{symbol_short, token, vec, Address, BytesN, Env, Event, IntoVal, String, Symbol, Vec};

/// One USDC in stroops (7 decimals).
const USDC: i128 = 10_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct World {
    env: Env,
    contract: Address,
    token: Address,
}

fn world() -> World {
    let env = Env::default();
    let contract = env.register(SplitRouter, ());
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    World {
        env,
        contract,
        token,
    }
}

impl World {
    fn client(&self) -> SplitRouterClient<'_> {
        SplitRouterClient::new(&self.env, &self.contract)
    }
    fn mint(&self, to: &Address, amount: i128) {
        // Minting is an admin action on the SAC; auth for it is mocked here only.
        token::StellarAssetClient::new(&self.env, &self.token)
            .mock_all_auths()
            .mint(to, &amount);
    }
    fn token_balance(&self, of: &Address) -> i128 {
        token::TokenClient::new(&self.env, &self.token).balance(of)
    }
    fn slug(&self, s: &str) -> String {
        String::from_str(&self.env, s)
    }
    fn shares(&self, table: &[(&Address, u32)]) -> Vec<Share> {
        let mut v = Vec::new(&self.env);
        for (addr, bps) in table {
            v.push_back(Share {
                addr: (*addr).clone(),
                bps: *bps,
            });
        }
        v
    }
    fn deps(&self, table: &[(u32, u32)]) -> Vec<DepShare> {
        let mut v = Vec::new(&self.env);
        for (project_id, bps) in table {
            v.push_back(DepShare {
                project_id: *project_id,
                bps: *bps,
            });
        }
        v
    }
    fn memo(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }
    /// Register a single-maintainer project with no dependencies (auth mocked).
    fn simple_project(&self, slug: &str, owner: &Address, maintainer: &Address) -> u32 {
        self.env.mock_all_auths();
        self.client().register_project(
            owner,
            &self.slug(slug),
            &self.shares(&[(maintainer, 10_000)]),
            &self.deps(&[]),
        )
    }
}

fn contract_error<T: core::fmt::Debug, C: core::fmt::Debug>(
    r: Result<Result<T, C>, Result<Error, soroban_sdk::InvokeError>>,
) -> Error {
    match r {
        Err(Ok(e)) => e,
        other => panic!("expected contract error, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// register_project
// ---------------------------------------------------------------------------

#[test]
fn register_project_assigns_ids_records_table_and_requires_owner_auth() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let m1 = Address::generate(&w.env);
    let m2 = Address::generate(&w.env);
    let maintainers = w.shares(&[(&m1, 6_000), (&m2, 4_000)]);
    let deps = w.deps(&[]);

    w.env.mock_all_auths();
    let id = client.register_project(&owner, &w.slug("bufring"), &maintainers, &deps);
    assert_eq!(id, 1);
    // Events are captured right after the call: any later invocation (even a
    // view) replaces the "last invocation" event list.
    let register_events = w.env.events().all().filter_by_contract(&w.contract);

    // The owner, and only the owner, authorized the call.
    assert_eq!(
        w.env.auths(),
        std::vec![(
            owner.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    w.contract.clone(),
                    Symbol::new(&w.env, "register_project"),
                    (
                        owner.clone(),
                        w.slug("bufring"),
                        maintainers.clone(),
                        deps.clone()
                    )
                        .into_val(&w.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );

    let p = client.project(&id);
    assert_eq!(
        p,
        Project {
            id: 1,
            owner: owner.clone(),
            slug: w.slug("bufring"),
            version: 1,
            maintainers: maintainers.clone(),
            dependencies: deps.clone(),
            active: true,
        }
    );
    assert_eq!(client.project_count(), 1);
    assert_eq!(client.project_id_by_slug(&w.slug("bufring")), Some(1));
    assert_eq!(client.project_id_by_slug(&w.slug("nope")), None);

    // Event: ("depsplit", "register", id) with owner/slug/version data.
    assert_eq!(
        register_events.events(),
        &[ProjectRegistered {
            id: 1,
            owner: owner.clone(),
            slug: w.slug("bufring"),
            version: 1,
        }
        .to_xdr(&w.env, &w.contract)]
    );

    // Second project with a dependency on the first.
    let id2 = client.register_project(
        &owner,
        &w.slug("utf8-guard"),
        &w.shares(&[(&m1, 7_000)]),
        &w.deps(&[(1, 3_000)]),
    );
    assert_eq!(id2, 2);
    assert_eq!(client.project_count(), 2);
    assert_eq!(client.project(&2).dependencies, w.deps(&[(1, 3_000)]));
}

#[test]
fn register_project_rejects_caller_who_is_not_owner() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let intruder = Address::generate(&w.env);
    let m = Address::generate(&w.env);
    let maintainers = w.shares(&[(&m, 10_000)]);
    let deps = w.deps(&[]);
    let slug = w.slug("x");

    // Only `intruder` signs, so `owner.require_auth()` must fail.
    w.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &w.contract,
            fn_name: "register_project",
            args: (owner.clone(), slug.clone(), maintainers.clone(), deps.clone()).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    let r = client.try_register_project(&owner, &slug, &maintainers, &deps);
    assert!(r.is_err());
    assert_eq!(client.project_count(), 0);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn register_project_without_any_auth_panics() {
    let w = world();
    let owner = Address::generate(&w.env);
    let m = Address::generate(&w.env);
    // No mock_all_auths: the require_auth fails inside the host.
    w.client().register_project(
        &owner,
        &w.slug("x"),
        &w.shares(&[(&m, 10_000)]),
        &w.deps(&[]),
    );
}

#[test]
fn register_project_validates_table() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let m1 = Address::generate(&w.env);
    let m2 = Address::generate(&w.env);
    w.env.mock_all_auths();

    // Sum != 10_000
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[(&m1, 6_000), (&m2, 3_999)]),
        &w.deps(&[]),
    ));
    assert_eq!(e, Error::SplitSumMismatch);
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[(&m1, 6_000), (&m2, 4_001)]),
        &w.deps(&[]),
    ));
    assert_eq!(e, Error::SplitSumMismatch);

    // No maintainers
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[]),
        &w.deps(&[]),
    ));
    assert_eq!(e, Error::NoMaintainers);

    // Zero-bps share
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[(&m1, 10_000), (&m2, 0)]),
        &w.deps(&[]),
    ));
    assert_eq!(e, Error::ZeroBps);

    // Duplicate maintainer
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[(&m1, 5_000), (&m1, 5_000)]),
        &w.deps(&[]),
    ));
    assert_eq!(e, Error::DuplicateMaintainer);

    // Unknown dependency (nothing registered yet)
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[(&m1, 8_000)]),
        &w.deps(&[(7, 2_000)]),
    ));
    assert_eq!(e, Error::DependencyNotFound);

    // Self dependency: the id about to be assigned is 1.
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[(&m1, 8_000)]),
        &w.deps(&[(1, 2_000)]),
    ));
    assert_eq!(e, Error::SelfDependency);

    // Bad slugs
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug(""),
        &w.shares(&[(&m1, 10_000)]),
        &w.deps(&[]),
    ));
    assert_eq!(e, Error::InvalidSlug);
    let long = "x".repeat(65);
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug(&long),
        &w.shares(&[(&m1, 10_000)]),
        &w.deps(&[]),
    ));
    assert_eq!(e, Error::InvalidSlug);

    // Too many maintainers
    let mut many = Vec::new(&w.env);
    for _ in 0..(MAX_MAINTAINERS + 1) {
        many.push_back(Share {
            addr: Address::generate(&w.env),
            bps: 1,
        });
    }
    let e = contract_error(client.try_register_project(&owner, &w.slug("a"), &many, &w.deps(&[])));
    assert_eq!(e, Error::TooManyShares);

    // Nothing was registered by any of the failed attempts.
    assert_eq!(client.project_count(), 0);

    // A valid one, then its slug is taken and a duplicate dependency is rejected.
    let id = client.register_project(&owner, &w.slug("a"), &w.shares(&[(&m1, 10_000)]), &w.deps(&[]));
    assert_eq!(id, 1);
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[(&m1, 10_000)]),
        &w.deps(&[]),
    ));
    assert_eq!(e, Error::SlugTaken);
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("b"),
        &w.shares(&[(&m1, 6_000)]),
        &w.deps(&[(1, 2_000), (1, 2_000)]),
    ));
    assert_eq!(e, Error::DuplicateDependency);
    let e = contract_error(client.try_register_project(
        &owner,
        &w.slug("b"),
        &w.shares(&[(&m1, 6_000)]),
        &w.deps(&[(1, 0), (1, 4_000)]),
    ));
    assert_eq!(e, Error::ZeroBps);
    assert_eq!(client.project_count(), 1);
}

// ---------------------------------------------------------------------------
// update_splits / set_active
// ---------------------------------------------------------------------------

#[test]
fn update_splits_bumps_version_replaces_table_and_emits_event() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let m1 = Address::generate(&w.env);
    let m2 = Address::generate(&w.env);
    let dep_owner = Address::generate(&w.env);
    let dep_id = w.simple_project("dep", &dep_owner, &m2);
    let id = w.simple_project("main", &owner, &m1);

    let new_m = w.shares(&[(&m1, 5_000), (&m2, 2_500)]);
    let new_d = w.deps(&[(dep_id, 2_500)]);
    let v = client.update_splits(&id, &new_m, &new_d);
    let evs = w.env.events().all().filter_by_contract(&w.contract);
    let auths = w.env.auths();
    assert_eq!(v, 2);
    let p = client.project(&id);
    assert_eq!(p.version, 2);
    assert_eq!(p.maintainers, new_m);
    assert_eq!(p.dependencies, new_d);
    assert_eq!(p.owner, owner);
    assert_eq!(p.slug, w.slug("main"));

    assert_eq!(
        evs.events(),
        &[SplitsUpdated { id, version: 2 }.to_xdr(&w.env, &w.contract)]
    );

    // The owner authorized.
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, owner);

    // Another update -> version 3
    assert_eq!(client.update_splits(&id, &w.shares(&[(&m1, 10_000)]), &w.deps(&[])), 3);
}

#[test]
fn update_splits_rejects_non_owner_and_invalid_tables() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let intruder = Address::generate(&w.env);
    let m1 = Address::generate(&w.env);
    let id = w.simple_project("main", &owner, &m1);

    // Non-owner signs: rejected.
    let table = w.shares(&[(&intruder, 10_000)]);
    let deps = w.deps(&[]);
    w.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &w.contract,
            fn_name: "update_splits",
            args: (id, table.clone(), deps.clone()).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_update_splits(&id, &table, &deps).is_err());
    assert_eq!(client.project(&id).version, 1);
    assert_eq!(client.project(&id).maintainers, w.shares(&[(&m1, 10_000)]));

    w.env.mock_all_auths();
    // Unknown project
    let e = contract_error(client.try_update_splits(&99, &table, &deps));
    assert_eq!(e, Error::ProjectNotFound);
    // Self dependency
    let e = contract_error(client.try_update_splits(
        &id,
        &w.shares(&[(&m1, 9_000)]),
        &w.deps(&[(id, 1_000)]),
    ));
    assert_eq!(e, Error::SelfDependency);
    // Bad sum
    let e = contract_error(client.try_update_splits(&id, &w.shares(&[(&m1, 9_999)]), &deps));
    assert_eq!(e, Error::SplitSumMismatch);
    // Unknown dependency
    let e = contract_error(client.try_update_splits(
        &id,
        &w.shares(&[(&m1, 9_000)]),
        &w.deps(&[(42, 1_000)]),
    ));
    assert_eq!(e, Error::DependencyNotFound);
    // Version unchanged by any failure.
    assert_eq!(client.project(&id).version, 1);
}

#[test]
fn set_active_pauses_pay_and_distribute_and_requires_owner() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let intruder = Address::generate(&w.env);
    let m1 = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    let id = w.simple_project("main", &owner, &m1);
    w.mint(&payer, 100 * USDC);

    // Intruder cannot pause.
    w.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &w.contract,
            fn_name: "set_active",
            args: (id, false).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_set_active(&id, &false).is_err());
    assert!(client.project(&id).active);

    w.env.mock_all_auths();
    client.pay(&id, &payer, &w.token, &(10 * USDC), &w.memo(1));
    client.set_active(&id, &false);
    let evs = w.env.events().all().filter_by_contract(&w.contract);
    assert!(!client.project(&id).active);
    assert_eq!(
        evs.events(),
        &[ActiveChanged { id, active: false }.to_xdr(&w.env, &w.contract)]
    );

    let e = contract_error(client.try_pay(&id, &payer, &w.token, &(10 * USDC), &w.memo(2)));
    assert_eq!(e, Error::ProjectInactive);
    let e = contract_error(client.try_distribute_pool(&id, &w.token));
    assert_eq!(e, Error::ProjectInactive);
    // Balances credited before the pause are still withdrawable.
    assert_eq!(client.withdraw(&w.token, &m1), 10 * USDC);

    // Unknown project
    let e = contract_error(client.try_set_active(&77, &true));
    assert_eq!(e, Error::ProjectNotFound);

    // Resume, pay again.
    client.set_active(&id, &true);
    client.pay(&id, &payer, &w.token, &(5 * USDC), &w.memo(3));
    assert_eq!(client.balance(&w.token, &m1), 5 * USDC);
}

// ---------------------------------------------------------------------------
// pay
// ---------------------------------------------------------------------------

#[test]
fn pay_credits_maintainers_pools_and_dust_exactly() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let a1 = Address::generate(&w.env);
    let a2 = Address::generate(&w.env);
    let dep_owner = Address::generate(&w.env);
    let dep_m = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    let dep = w.simple_project("dep", &dep_owner, &dep_m);
    w.env.mock_all_auths();
    let id = client.register_project(
        &owner,
        &w.slug("main"),
        &w.shares(&[(&a1, 4_000), (&a2, 3_000)]),
        &w.deps(&[(dep, 3_000)]),
    );

    // 1,234.5678901 USDC -> not divisible by 10_000 stroops, so dust appears.
    let amount: i128 = 12_345_678_901;
    w.mint(&payer, amount);
    client.pay(&id, &payer, &w.token, &amount, &w.memo(9));
    let evs = w.env.events().all().filter_by_contract(&w.contract);
    let auths = w.env.auths();

    let a1_share = amount * 4_000 / 10_000; // 4_938_271_560 (floor of .4)
    let a2_share = amount * 3_000 / 10_000; // 3_703_703_670 (floor of .3)
    let dep_share = amount * 3_000 / 10_000; // 3_703_703_670
    let dust = amount - a1_share - a2_share - dep_share; // 1
    assert_eq!(a1_share, 4_938_271_560);
    assert_eq!(a2_share, 3_703_703_670);
    assert_eq!(dust, 1);
    assert_eq!(client.balance(&w.token, &a1), a1_share);
    assert_eq!(client.balance(&w.token, &a2), a2_share);
    assert_eq!(client.pool(&w.token, &dep), dep_share);
    assert_eq!(client.balance(&w.token, &owner), dust);
    assert_eq!(client.pool(&w.token, &id), 0);
    // Tokens actually moved into the contract.
    assert_eq!(w.token_balance(&payer), 0);
    assert_eq!(w.token_balance(&w.contract), amount);

    // Event carries the memo hash, version and dust.
    assert_eq!(
        evs.events(),
        &[Paid {
            id,
            from: payer.clone(),
            token: w.token.clone(),
            amount,
            memo_hash: w.memo(9),
            version: 1,
            dust,
        }
        .to_xdr(&w.env, &w.contract)]
    );

    // Payer authorized the pay call (with the token transfer as sub-invocation).
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, payer);
    match &auths[0].1.function {
        AuthorizedFunction::Contract((c, f, _)) => {
            assert_eq!(c, &w.contract);
            assert_eq!(f, &symbol_short!("pay"));
        }
        other => panic!("unexpected auth {:?}", other),
    }
}

#[test]
fn pay_rejects_zero_negative_unknown_and_unauthorized() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let m1 = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    let intruder = Address::generate(&w.env);
    let id = w.simple_project("main", &owner, &m1);
    w.mint(&payer, 100 * USDC);

    w.env.mock_all_auths();
    let e = contract_error(client.try_pay(&id, &payer, &w.token, &0, &w.memo(0)));
    assert_eq!(e, Error::InvalidAmount);
    let e = contract_error(client.try_pay(&id, &payer, &w.token, &-5, &w.memo(0)));
    assert_eq!(e, Error::InvalidAmount);
    let e = contract_error(client.try_pay(&123, &payer, &w.token, &USDC, &w.memo(0)));
    assert_eq!(e, Error::ProjectNotFound);
    // Payer has fewer tokens than the amount: the SAC transfer fails and the
    // whole call is rolled back, no credit happens.
    assert!(client
        .try_pay(&id, &payer, &w.token, &(1_000 * USDC), &w.memo(0))
        .is_err());
    assert_eq!(client.balance(&w.token, &m1), 0);
    assert_eq!(w.token_balance(&payer), 100 * USDC);

    // Someone else signing cannot spend the payer's tokens.
    w.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &w.contract,
            fn_name: "pay",
            args: (id, payer.clone(), w.token.clone(), USDC, w.memo(0)).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_pay(&id, &payer, &w.token, &USDC, &w.memo(0)).is_err());
    assert_eq!(client.balance(&w.token, &m1), 0);
    assert_eq!(w.token_balance(&payer), 100 * USDC);
}

#[test]
fn pay_overflow_is_rejected_atomically() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let m1 = Address::generate(&w.env);
    let m2 = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    w.env.mock_all_auths();
    let id = client.register_project(
        &owner,
        &w.slug("main"),
        &w.shares(&[(&m1, 5_000), (&m2, 5_000)]),
        &w.deps(&[]),
    );
    // amount * 5_000 overflows i128 -> Overflow, and the token transfer that
    // already happened inside the call is rolled back with it.
    let amount = i128::MAX / 2;
    w.mint(&payer, amount);
    let e = contract_error(client.try_pay(&id, &payer, &w.token, &amount, &w.memo(1)));
    assert_eq!(e, Error::Overflow);
    assert_eq!(w.token_balance(&payer), amount);
    assert_eq!(w.token_balance(&w.contract), 0);
    assert_eq!(client.balance(&w.token, &m1), 0);
}

// ---------------------------------------------------------------------------
// distribute_pool
// ---------------------------------------------------------------------------

#[test]
fn distribute_pool_settles_one_hop_per_call_without_auth() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let a1 = Address::generate(&w.env);
    let b1 = Address::generate(&w.env);
    let c1 = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    w.env.mock_all_auths();
    let c = client.register_project(&owner, &w.slug("c"), &w.shares(&[(&c1, 10_000)]), &w.deps(&[]));
    let b = client.register_project(
        &owner,
        &w.slug("b"),
        &w.shares(&[(&b1, 7_000)]),
        &w.deps(&[(c, 3_000)]),
    );
    let a = client.register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[(&a1, 8_000)]),
        &w.deps(&[(b, 2_000)]),
    );
    w.mint(&payer, 1_000 * USDC);
    client.pay(&a, &payer, &w.token, &(1_000 * USDC), &w.memo(1));

    // One hop: B's pool has A's 20%, C has nothing yet.
    assert_eq!(client.balance(&w.token, &a1), 800 * USDC);
    assert_eq!(client.pool(&w.token, &b), 200 * USDC);
    assert_eq!(client.pool(&w.token, &c), 0);
    assert_eq!(client.balance(&w.token, &c1), 0);

    // Anyone can distribute: no auth recorded.
    let moved = client.distribute_pool(&b, &w.token);
    let evs = w.env.events().all().filter_by_contract(&w.contract);
    assert_eq!(moved, 200 * USDC);
    assert!(w.env.auths().is_empty());
    assert_eq!(client.pool(&w.token, &b), 0);
    assert_eq!(client.balance(&w.token, &b1), 140 * USDC);
    assert_eq!(client.pool(&w.token, &c), 60 * USDC);
    assert_eq!(
        evs.events(),
        &[PoolDistributed {
            id: b,
            token: w.token.clone(),
            amount: 200 * USDC,
            version: 1,
            dust: 0,
        }
        .to_xdr(&w.env, &w.contract)]
    );

    // Second hop.
    assert_eq!(client.distribute_pool(&c, &w.token), 60 * USDC);
    assert_eq!(client.balance(&w.token, &c1), 60 * USDC);

    // Empty pools and unknown projects are rejected.
    let e = contract_error(client.try_distribute_pool(&b, &w.token));
    assert_eq!(e, Error::EmptyPool);
    let e = contract_error(client.try_distribute_pool(&c, &w.token));
    assert_eq!(e, Error::EmptyPool);
    let e = contract_error(client.try_distribute_pool(&404, &w.token));
    assert_eq!(e, Error::ProjectNotFound);

    // Global conservation: contract holds exactly what is owed.
    let owed = client.balance(&w.token, &a1)
        + client.balance(&w.token, &b1)
        + client.balance(&w.token, &c1)
        + client.balance(&w.token, &owner);
    assert_eq!(owed, 1_000 * USDC);
    assert_eq!(w.token_balance(&w.contract), 1_000 * USDC);
}

#[test]
fn distribute_pool_uses_the_current_table_version() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let a1 = Address::generate(&w.env);
    let b_old = Address::generate(&w.env);
    let b_new = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    w.env.mock_all_auths();
    let b = client.register_project(&owner, &w.slug("b"), &w.shares(&[(&b_old, 10_000)]), &w.deps(&[]));
    let a = client.register_project(
        &owner,
        &w.slug("a"),
        &w.shares(&[(&a1, 5_000)]),
        &w.deps(&[(b, 5_000)]),
    );
    w.mint(&payer, 100 * USDC);
    client.pay(&a, &payer, &w.token, &(100 * USDC), &w.memo(1));
    assert_eq!(client.pool(&w.token, &b), 50 * USDC);

    // B changes its table before the pool is distributed: the pool follows v2.
    client.update_splits(&b, &w.shares(&[(&b_new, 10_000)]), &w.deps(&[]));
    client.distribute_pool(&b, &w.token);
    assert_eq!(client.balance(&w.token, &b_old), 0);
    assert_eq!(client.balance(&w.token, &b_new), 50 * USDC);
}

#[test]
fn dependency_cycle_created_by_update_terminates_under_repeated_distribution() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let a1 = Address::generate(&w.env);
    let b1 = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    w.env.mock_all_auths();
    let a = client.register_project(&owner, &w.slug("a"), &w.shares(&[(&a1, 10_000)]), &w.deps(&[]));
    let b = client.register_project(
        &owner,
        &w.slug("b"),
        &w.shares(&[(&b1, 5_000)]),
        &w.deps(&[(a, 5_000)]),
    );
    // A now depends on B: a 2-cycle. Registration could not have created it
    // (B did not exist), update_splits can.
    client.update_splits(&a, &w.shares(&[(&a1, 5_000)]), &w.deps(&[(b, 5_000)]));

    let amount = 1_000 * USDC;
    w.mint(&payer, amount);
    client.pay(&a, &payer, &w.token, &amount, &w.memo(1));

    // Each hop halves what is left; rounding pushes the tail to owners as dust.
    let mut hops = 0;
    loop {
        let mut progressed = false;
        if client.pool(&w.token, &a) > 0 {
            client.distribute_pool(&a, &w.token);
            progressed = true;
        }
        if client.pool(&w.token, &b) > 0 {
            client.distribute_pool(&b, &w.token);
            progressed = true;
        }
        hops += 1;
        if !progressed {
            break;
        }
        assert!(hops < 200, "cycle did not terminate");
    }
    let owed = client.balance(&w.token, &a1) + client.balance(&w.token, &b1) + client.balance(&w.token, &owner);
    assert_eq!(owed, amount);
    assert_eq!(client.pool(&w.token, &a), 0);
    assert_eq!(client.pool(&w.token, &b), 0);
}

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------

#[test]
fn withdraw_moves_tokens_out_and_zeroes_balance() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let m1 = Address::generate(&w.env);
    let m2 = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    w.env.mock_all_auths();
    let id = client.register_project(
        &owner,
        &w.slug("main"),
        &w.shares(&[(&m1, 2_500), (&m2, 7_500)]),
        &w.deps(&[]),
    );
    w.mint(&payer, 400 * USDC);
    client.pay(&id, &payer, &w.token, &(400 * USDC), &w.memo(1));

    let got = client.withdraw(&w.token, &m1);
    let evs = w.env.events().all().filter_by_contract(&w.contract);
    let auths = w.env.auths();
    assert_eq!(got, 100 * USDC);
    assert_eq!(w.token_balance(&m1), 100 * USDC);
    assert_eq!(client.balance(&w.token, &m1), 0);
    assert_eq!(w.token_balance(&w.contract), 300 * USDC);
    // m2's balance is untouched by m1's withdrawal.
    assert_eq!(client.balance(&w.token, &m2), 300 * USDC);

    assert_eq!(
        evs.events(),
        &[Withdrawn {
            to: m1.clone(),
            token: w.token.clone(),
            amount: 100 * USDC,
        }
        .to_xdr(&w.env, &w.contract)]
    );
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, m1);

    // Nothing left -> rejected; never-credited address -> rejected.
    let e = contract_error(client.try_withdraw(&w.token, &m1));
    assert_eq!(e, Error::NothingToWithdraw);
    let stranger = Address::generate(&w.env);
    let e = contract_error(client.try_withdraw(&w.token, &stranger));
    assert_eq!(e, Error::NothingToWithdraw);

    // Later credits accrue again and can be withdrawn again.
    w.mint(&payer, 40 * USDC);
    client.pay(&id, &payer, &w.token, &(40 * USDC), &w.memo(2));
    assert_eq!(client.withdraw(&w.token, &m1), 10 * USDC);
    assert_eq!(w.token_balance(&m1), 110 * USDC);
}

#[test]
fn withdraw_requires_recipient_auth_and_is_per_token() {
    let w = world();
    let client = w.client();
    let owner = Address::generate(&w.env);
    let m1 = Address::generate(&w.env);
    let thief = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    let id = w.simple_project("main", &owner, &m1);
    w.mint(&payer, 10 * USDC);
    // A second token to check isolation.
    let admin2 = Address::generate(&w.env);
    let token2 = w.env.register_stellar_asset_contract_v2(admin2).address();
    token::StellarAssetClient::new(&w.env, &token2)
        .mock_all_auths()
        .mint(&payer, &(3 * USDC));

    w.env.mock_all_auths();
    client.pay(&id, &payer, &w.token, &(10 * USDC), &w.memo(1));
    client.pay(&id, &payer, &token2, &(3 * USDC), &w.memo(2));
    assert_eq!(client.balance(&w.token, &m1), 10 * USDC);
    assert_eq!(client.balance(&token2, &m1), 3 * USDC);

    // Thief signs for a withdrawal to m1: `to.require_auth()` fails.
    w.env.mock_auths(&[MockAuth {
        address: &thief,
        invoke: &MockAuthInvoke {
            contract: &w.contract,
            fn_name: "withdraw",
            args: (w.token.clone(), m1.clone()).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_withdraw(&w.token, &m1).is_err());
    assert_eq!(client.balance(&w.token, &m1), 10 * USDC);

    // m1 withdraws token 1 only; token 2 balance stays.
    w.env.mock_auths(&[MockAuth {
        address: &m1,
        invoke: &MockAuthInvoke {
            contract: &w.contract,
            fn_name: "withdraw",
            args: (w.token.clone(), m1.clone()).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(client.withdraw(&w.token, &m1), 10 * USDC);
    assert_eq!(client.balance(&w.token, &m1), 0);
    assert_eq!(client.balance(&token2, &m1), 3 * USDC);
    assert_eq!(w.token_balance(&m1), 10 * USDC);
}

// ---------------------------------------------------------------------------
// Property-style: value is conserved for random tables and amounts
// ---------------------------------------------------------------------------

/// Tiny deterministic PRNG (xorshift64*) so the test is reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Split 10_000 bps into `n` strictly positive random parts.
fn random_bps(rng: &mut Rng, n: usize) -> std::vec::Vec<u32> {
    let mut cuts: std::vec::Vec<u32> = (0..n - 1).map(|_| 1 + rng.below(9_999) as u32).collect();
    cuts.sort_unstable();
    cuts.dedup();
    while cuts.len() < n - 1 {
        // Extremely unlikely collision: fill deterministically.
        let mut c = 1;
        while cuts.contains(&c) {
            c += 1;
        }
        cuts.push(c);
        cuts.sort_unstable();
    }
    let mut parts = std::vec::Vec::with_capacity(n);
    let mut prev = 0;
    for c in cuts {
        parts.push(c - prev);
        prev = c;
    }
    parts.push(10_000 - prev);
    assert!(parts.iter().all(|&p| p > 0));
    assert_eq!(parts.iter().sum::<u32>(), 10_000);
    parts
}

#[test]
fn property_random_tables_conserve_value_on_pay_and_distribute() {
    let w = world();
    let client = w.client();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let owner = Address::generate(&w.env);
    let payer = Address::generate(&w.env);
    w.env.mock_all_auths();

    // Two fixed dependencies with their own random tables.
    let dep_maintainers: std::vec::Vec<Address> = (0..3).map(|_| Address::generate(&w.env)).collect();
    let dep_bps = random_bps(&mut rng, 3);
    let dep_table = w.shares(&[
        (&dep_maintainers[0], dep_bps[0]),
        (&dep_maintainers[1], dep_bps[1]),
        (&dep_maintainers[2], dep_bps[2]),
    ]);
    let dep_b = client.register_project(&owner, &w.slug("dep-b"), &dep_table, &w.deps(&[]));
    let dep_c = client.register_project(&owner, &w.slug("dep-c"), &dep_table, &w.deps(&[]));

    let mut all_recipients: std::vec::Vec<Address> = dep_maintainers.clone();
    all_recipients.push(owner.clone());
    let mut total_paid: i128 = 0;

    for i in 0..60u32 {
        let n_m = 1 + rng.below(6) as usize;
        let n_d = rng.below(3) as usize; // 0, 1 or 2 dependencies
        let parts = random_bps(&mut rng, n_m + n_d);
        let maintainers: std::vec::Vec<Address> = (0..n_m).map(|_| Address::generate(&w.env)).collect();
        let mut m_vec = Vec::new(&w.env);
        for (k, m) in maintainers.iter().enumerate() {
            m_vec.push_back(Share {
                addr: m.clone(),
                bps: parts[k],
            });
        }
        let mut d_vec = Vec::new(&w.env);
        let dep_ids = [dep_b, dep_c];
        for k in 0..n_d {
            d_vec.push_back(DepShare {
                project_id: dep_ids[k],
                bps: parts[n_m + k],
            });
        }
        let slug = std::format!("p-{}", i);
        let id = client.register_project(&owner, &w.slug(&slug), &m_vec, &d_vec);
        all_recipients.extend(maintainers.iter().cloned());

        // Amounts: tiny (1..=20 stroops), typical, and very large.
        let amount: i128 = match i % 3 {
            0 => 1 + rng.below(20) as i128,
            1 => 1 + rng.below(10_000_000_000) as i128,
            _ => 1 + (rng.next() as i128) * 1_000_003,
        };
        w.mint(&payer, amount);

        let before_m: std::vec::Vec<i128> = maintainers.iter().map(|m| client.balance(&w.token, m)).collect();
        let before_owner = client.balance(&w.token, &owner);
        let before_pool_b = client.pool(&w.token, &dep_b);
        let before_pool_c = client.pool(&w.token, &dep_c);

        client.pay(&id, &payer, &w.token, &amount, &w.memo((i % 255) as u8));
        total_paid += amount;

        let mut credited: i128 = 0;
        for (k, m) in maintainers.iter().enumerate() {
            let delta = client.balance(&w.token, m) - before_m[k];
            assert_eq!(delta, amount * parts[k] as i128 / 10_000, "maintainer share, iter {}", i);
            credited += delta;
        }
        credited += client.pool(&w.token, &dep_b) - before_pool_b;
        credited += client.pool(&w.token, &dep_c) - before_pool_c;
        let dust = client.balance(&w.token, &owner) - before_owner;
        assert!(dust >= 0 && dust < (n_m + n_d) as i128, "dust bounded by share count, iter {}", i);
        assert_eq!(credited + dust, amount, "no value created or lost on pay, iter {}", i);
    }

    // Distribute both dependency pools and check conservation again.
    for dep in [dep_b, dep_c] {
        let pool = client.pool(&w.token, &dep);
        if pool == 0 {
            continue;
        }
        let before: std::vec::Vec<i128> = dep_maintainers.iter().map(|m| client.balance(&w.token, m)).collect();
        let before_owner = client.balance(&w.token, &owner);
        assert_eq!(client.distribute_pool(&dep, &w.token), pool);
        let mut credited: i128 = 0;
        for (k, m) in dep_maintainers.iter().enumerate() {
            let delta = client.balance(&w.token, m) - before[k];
            assert_eq!(delta, pool * dep_bps[k] as i128 / 10_000);
            credited += delta;
        }
        let dust = client.balance(&w.token, &owner) - before_owner;
        assert!(dust >= 0 && dust < 3);
        assert_eq!(credited + dust, pool, "no value created or lost on distribute");
        assert_eq!(client.pool(&w.token, &dep), 0);
    }

    // Global invariant: contract token balance == sum of every withdrawable balance.
    let owed: i128 = all_recipients.iter().map(|a| client.balance(&w.token, a)).sum();
    assert_eq!(owed, total_paid);
    assert_eq!(w.token_balance(&w.contract), total_paid);

    // And every recipient can actually withdraw what is owed.
    for a in all_recipients.iter() {
        let owed = client.balance(&w.token, a);
        if owed > 0 {
            assert_eq!(client.withdraw(&w.token, a), owed);
            assert_eq!(w.token_balance(a), owed);
        }
    }
    assert_eq!(w.token_balance(&w.contract), 0);
}

// ---------------------------------------------------------------------------
// Scenario: three projects, a foundation payer, pools, withdrawals, re-versioning
// ---------------------------------------------------------------------------

#[test]
fn scenario_three_projects() {
    let w = world();
    let client = w.client();
    let env = &w.env;
    let usdc = &w.token;

    // Roles
    let foundation = Address::generate(env);
    let company = Address::generate(env);
    let owner_a = Address::generate(env);
    let owner_b = Address::generate(env);
    let owner_c = Address::generate(env);
    let a1 = Address::generate(env);
    let a2 = Address::generate(env);
    let b1 = Address::generate(env);
    let c1 = Address::generate(env);
    let c2 = Address::generate(env);
    let c3 = Address::generate(env);

    std::println!("== DepSplit scenario: three projects ==");
    env.mock_all_auths();

    // C: leaf library, three maintainers (one of them outside Stripe's payout list).
    let c = client.register_project(
        &owner_c,
        &w.slug("bufring"),
        &w.shares(&[(&c1, 4_500), (&c2, 3_000), (&c3, 2_500)]),
        &w.deps(&[]),
    );
    // B: depends on C at 30%.
    let b = client.register_project(
        &owner_b,
        &w.slug("utf8-guard"),
        &w.shares(&[(&b1, 7_000)]),
        &w.deps(&[(c, 3_000)]),
    );
    // A: depends on B at 20% and C at 10%.
    let a = client.register_project(
        &owner_a,
        &w.slug("quickparse"),
        &w.shares(&[(&a1, 4_000), (&a2, 3_000)]),
        &w.deps(&[(b, 2_000), (c, 1_000)]),
    );
    std::println!("registered: quickparse=#{} (v1), utf8-guard=#{} (v1), bufring=#{} (v1)", a, b, c);
    assert_eq!((a, b, c), (3, 2, 1));

    // The foundation pays A 5,000 USDC and B 1,000 USDC.
    w.mint(&foundation, 6_000 * USDC);
    client.pay(&a, &foundation, usdc, &(5_000 * USDC), &w.memo(0xA1));
    client.pay(&b, &foundation, usdc, &(1_000 * USDC), &w.memo(0xB1));
    std::println!("foundation paid quickparse 5000.0000000 and utf8-guard 1000.0000000");

    // After pay(A): a1 2000, a2 1500, pool B 1000, pool C 500.
    // After pay(B): b1 700, pool C +300 -> 800.
    assert_eq!(client.balance(usdc, &a1), 2_000 * USDC);
    assert_eq!(client.balance(usdc, &a2), 1_500 * USDC);
    assert_eq!(client.balance(usdc, &b1), 700 * USDC);
    assert_eq!(client.pool(usdc, &b), 1_000 * USDC);
    assert_eq!(client.pool(usdc, &c), 800 * USDC);
    assert_eq!(client.balance(usdc, &c1), 0);
    std::println!(
        "after pay: a1={} a2={} b1={} pool(utf8-guard)={} pool(bufring)={}",
        client.balance(usdc, &a1),
        client.balance(usdc, &a2),
        client.balance(usdc, &b1),
        client.pool(usdc, &b),
        client.pool(usdc, &c)
    );

    // Anyone settles the chain, one hop per call: B first, then C.
    let moved_b = client.distribute_pool(&b, usdc);
    assert_eq!(moved_b, 1_000 * USDC);
    // B pool 1000 -> b1 +700 (=1400), pool C +300 (=1100)
    assert_eq!(client.balance(usdc, &b1), 1_400 * USDC);
    assert_eq!(client.pool(usdc, &c), 1_100 * USDC);
    let moved_c = client.distribute_pool(&c, usdc);
    assert_eq!(moved_c, 1_100 * USDC);
    // C pool 1100 -> c1 495, c2 330, c3 275 (exact, no dust)
    assert_eq!(client.balance(usdc, &c1), 495 * USDC);
    assert_eq!(client.balance(usdc, &c2), 330 * USDC);
    assert_eq!(client.balance(usdc, &c3), 275 * USDC);
    assert_eq!(client.balance(usdc, &owner_c), 0);
    assert_eq!(client.pool(usdc, &b), 0);
    assert_eq!(client.pool(usdc, &c), 0);
    std::println!(
        "after distribute: b1={} c1={} c2={} c3={}",
        client.balance(usdc, &b1),
        client.balance(usdc, &c1),
        client.balance(usdc, &c2),
        client.balance(usdc, &c3)
    );

    // Every stroop is accounted for.
    let owed = client.balance(usdc, &a1)
        + client.balance(usdc, &a2)
        + client.balance(usdc, &b1)
        + client.balance(usdc, &c1)
        + client.balance(usdc, &c2)
        + client.balance(usdc, &c3);
    assert_eq!(owed, 6_000 * USDC);
    assert_eq!(w.token_balance(&w.contract), 6_000 * USDC);

    // Withdrawals (pull): c3 withdraws first, later a1; others leave funds parked.
    assert_eq!(client.withdraw(usdc, &c3), 275 * USDC);
    assert_eq!(w.token_balance(&c3), 275 * USDC);
    assert_eq!(client.withdraw(usdc, &a1), 2_000 * USDC);
    assert_eq!(w.token_balance(&a1), 2_000 * USDC);
    assert_eq!(client.balance(usdc, &a1), 0);
    assert_eq!(w.token_balance(&w.contract), 6_000 * USDC - 275 * USDC - 2_000 * USDC);
    std::println!("withdrawn: c3={} a1={}", w.token_balance(&c3), w.token_balance(&a1));

    // A re-versions its table: a2 leaves, a1 takes 55%, B 30%, C 15%.
    let v2 = client.update_splits(
        &a,
        &w.shares(&[(&a1, 5_500)]),
        &w.deps(&[(b, 3_000), (c, 1_500)]),
    );
    assert_eq!(v2, 2);
    assert_eq!(client.project(&a).version, 2);
    // Earlier balances are unchanged by the update.
    assert_eq!(client.balance(usdc, &a2), 1_500 * USDC);
    assert_eq!(client.balance(usdc, &b1), 1_400 * USDC);
    assert_eq!(client.pool(usdc, &b), 0);
    std::println!("quickparse table updated -> version {}", v2);

    // A company pays A a messy amount under v2: 1,234.5678901 USDC.
    let messy: i128 = 12_345_678_901;
    w.mint(&company, messy);
    client.pay(&a, &company, usdc, &messy, &w.memo(0xC2));
    let a1_v2 = messy * 5_500 / 10_000; // 6_790_123_395 (floor of .55)
    let b_v2 = messy * 3_000 / 10_000; // 3_703_703_670 (floor of .3)
    let c_v2 = messy * 1_500 / 10_000; // 1_851_851_835 (floor of .15)
    let dust = messy - a1_v2 - b_v2 - c_v2; // 1 stroop
    assert_eq!(a1_v2, 6_790_123_395);
    assert_eq!(dust, 1);
    assert_eq!(client.balance(usdc, &a1), a1_v2);
    assert_eq!(client.balance(usdc, &a2), 1_500 * USDC); // a2 got nothing under v2
    assert_eq!(client.pool(usdc, &b), b_v2);
    assert_eq!(client.pool(usdc, &c), c_v2);
    assert_eq!(client.balance(usdc, &owner_a), dust);
    std::println!(
        "company paid {} under v2: a1 +{} pool(utf8-guard) +{} pool(bufring) +{} dust->owner_a {}",
        messy, a1_v2, b_v2, c_v2, dust
    );

    // Settle the chain again and check to the stroop.
    client.distribute_pool(&b, usdc);
    let b1_v2 = b_v2 * 7_000 / 10_000; // 2_592_592_569
    let c_from_b = b_v2 * 3_000 / 10_000; // 1_111_111_101
    let dust_b = b_v2 - b1_v2 - c_from_b; // 0
    assert_eq!(client.balance(usdc, &b1), 1_400 * USDC + b1_v2);
    assert_eq!(client.balance(usdc, &owner_b), dust_b);
    let c_pool = c_v2 + c_from_b; // 2_962_962_936
    assert_eq!(client.pool(usdc, &c), c_pool);
    client.distribute_pool(&c, usdc);
    let c1_v2 = c_pool * 4_500 / 10_000;
    let c2_v2 = c_pool * 3_000 / 10_000;
    let c3_v2 = c_pool * 2_500 / 10_000;
    let dust_c = c_pool - c1_v2 - c2_v2 - c3_v2;
    assert_eq!(client.balance(usdc, &c1), 495 * USDC + c1_v2);
    assert_eq!(client.balance(usdc, &c2), 330 * USDC + c2_v2);
    assert_eq!(client.balance(usdc, &c3), c3_v2); // c3 withdrew earlier
    assert_eq!(client.balance(usdc, &owner_c), dust_c);

    // Final conservation: contract holds exactly the sum of all balances.
    let owed = client.balance(usdc, &a1)
        + client.balance(usdc, &a2)
        + client.balance(usdc, &b1)
        + client.balance(usdc, &c1)
        + client.balance(usdc, &c2)
        + client.balance(usdc, &c3)
        + client.balance(usdc, &owner_a)
        + client.balance(usdc, &owner_b)
        + client.balance(usdc, &owner_c);
    let held = w.token_balance(&w.contract);
    assert_eq!(owed, held);
    assert_eq!(held, 6_000 * USDC + messy - 275 * USDC - 2_000 * USDC);
    std::println!(
        "final: contract holds {} = sum of balances {}; a1={} a2={} b1={} c1={} c2={} c3={} owners a/b/c={}/{}/{}",
        held,
        owed,
        client.balance(usdc, &a1),
        client.balance(usdc, &a2),
        client.balance(usdc, &b1),
        client.balance(usdc, &c1),
        client.balance(usdc, &c2),
        client.balance(usdc, &c3),
        client.balance(usdc, &owner_a),
        client.balance(usdc, &owner_b),
        client.balance(usdc, &owner_c)
    );

    // Everyone can pull what they are owed; the contract ends empty.
    for who in [&a1, &a2, &b1, &c1, &c2, &c3, &owner_a, &owner_c] {
        let owed = client.balance(usdc, who);
        if owed > 0 {
            assert_eq!(client.withdraw(usdc, who), owed);
        }
    }
    assert_eq!(w.token_balance(&w.contract), 0);
    std::println!("all balances withdrawn; contract holds 0");
}

#[test]
fn views_default_to_zero_and_project_view_errors_on_unknown() {
    let w = world();
    let client = w.client();
    let nobody = Address::generate(&w.env);
    assert_eq!(client.balance(&w.token, &nobody), 0);
    assert_eq!(client.pool(&w.token, &1), 0);
    assert_eq!(client.project_count(), 0);
    let e = contract_error(client.try_project(&1));
    assert_eq!(e, Error::ProjectNotFound);
    let _ = vec![&w.env, 1u32];
}
