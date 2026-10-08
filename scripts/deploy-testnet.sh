#!/usr/bin/env bash
# Deploy split_router to Stellar testnet and register the seed projects.
#
# NOT EXECUTED in the environment where this repository was built: testnet RPC,
# Horizon and Friendbot were unreachable there (see TOOLCHAIN.md). The script is
# written against stellar-cli 28.0.0 and the commands documented at
# https://developers.stellar.org/docs/tools/cli — run it yourself with network access.
#
# Prerequisites: stellar-cli 28.x, Rust with the wasm32v1-none target, Node 22.
# Usage:
#   scripts/deploy-testnet.sh                 # generate + fund keys, deploy, register seed projects
#   DEPLOYER=alice scripts/deploy-testnet.sh  # reuse an existing stellar-cli identity
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NETWORK="${NETWORK:-testnet}"
DEPLOYER="${DEPLOYER:-depsplit-deployer}"
# Testnet USDC issuer (Circle's testnet issuer as commonly listed; verify before use).
USDC_ISSUER="${USDC_ISSUER:-GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5}"

echo "== 1. build wasm"
stellar contract build
WASM="$ROOT/target/wasm32v1-none/release/split_router.wasm"

echo "== 2. identities (funded by Friendbot)"
if ! stellar keys address "$DEPLOYER" >/dev/null 2>&1; then
  stellar keys generate --global "$DEPLOYER" --network "$NETWORK" --fund
fi
for who in depsplit-owner-a depsplit-owner-b depsplit-owner-c depsplit-foundation; do
  if ! stellar keys address "$who" >/dev/null 2>&1; then
    stellar keys generate --global "$who" --network "$NETWORK" --fund
  fi
done
echo "deployer:   $(stellar keys address "$DEPLOYER")"
echo "foundation: $(stellar keys address depsplit-foundation)"

echo "== 3. deploy split_router"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$DEPLOYER" \
  --network "$NETWORK" \
  --alias split_router)"
echo "DEPSPLIT_CONTRACT_ID=$CONTRACT_ID"

echo "== 4. USDC Stellar Asset Contract id"
USDC_ID="$(stellar contract id asset --network "$NETWORK" --asset "USDC:$USDC_ISSUER")"
echo "USDC_CONTRACT_ID=$USDC_ID"
# The SAC may need deploying once per network (idempotent; errors if it already exists):
stellar contract asset deploy --network "$NETWORK" --source "$DEPLOYER" --asset "USDC:$USDC_ISSUER" || true

echo "== 5. register the seed projects with stellar contract invoke"
# Slugs and tables mirror data/seed/*.json; owners are the identities above.
OWNER_C="$(stellar keys address depsplit-owner-c)"
OWNER_B="$(stellar keys address depsplit-owner-b)"
OWNER_A="$(stellar keys address depsplit-owner-a)"
M_C1=GCJXYABCESAM6QJ5RL7ITT7TO5APC2I3JEMW4UHO2PUODE6CJYVIKPJL
M_C2=GAJIRTXU7V3P2O5YIGL5G4454SBHNX4XTBF5IF6XU4XQIHKKC3LQKL22
M_C3=GD3Z6RCZL6YJ4PQXWYNKMNKMTZIBOPUH26PTVKC5DIYGXZCOMW7IDATV
M_B1=GCEV7CGJWVUHEJFI23QO3GVNDDI5X3H5THGGVT5WNAL6AIKZXAI4NC3M
M_A1=GDK7SBO7JYLB2VU26E5GM3CFAKWS7HUOYBHG2YWN3QO3XKLL4BR2ZA3A
M_A2=GDOAECAI7JQWDD3MYLSBJWCUQNT7KMRXLUHNWABX37CRK7KZGZ27G23J

# bufring (#1): three maintainers, no dependencies
stellar contract invoke --id "$CONTRACT_ID" --source depsplit-owner-c --network "$NETWORK" -- \
  register_project --owner "$OWNER_C" --slug bufring \
  --maintainers "[{\"addr\":\"$M_C1\",\"bps\":4500},{\"addr\":\"$M_C2\",\"bps\":3000},{\"addr\":\"$M_C3\",\"bps\":2500}]" \
  --dependencies '[]'
# utf8-guard (#2): 70% maintainer, 30% bufring
stellar contract invoke --id "$CONTRACT_ID" --source depsplit-owner-b --network "$NETWORK" -- \
  register_project --owner "$OWNER_B" --slug utf8-guard \
  --maintainers "[{\"addr\":\"$M_B1\",\"bps\":7000}]" \
  --dependencies '[{"project_id":1,"bps":3000}]'
# quickparse (#3): 40/30 maintainers, 20% utf8-guard, 10% bufring
stellar contract invoke --id "$CONTRACT_ID" --source depsplit-owner-a --network "$NETWORK" -- \
  register_project --owner "$OWNER_A" --slug quickparse \
  --maintainers "[{\"addr\":\"$M_A1\",\"bps\":4000},{\"addr\":\"$M_A2\",\"bps\":3000}]" \
  --dependencies '[{"project_id":2,"bps":2000},{"project_id":1,"bps":1000}]'

echo "== 6. next steps"
cat <<EOF
export DEPSPLIT_CONTRACT_ID=$CONTRACT_ID
export USDC_CONTRACT_ID=$USDC_ID
export DEPSPLIT_SECRET=\$(stellar keys show depsplit-foundation)   # payer
# Fund the foundation with testnet USDC from the issuer's faucet / an anchor, then:
cd app && npm run depsplit -- pay quickparse 5000 --memo "Q3 dependency fund - quickparse"
npm run depsplit -- distribute utf8-guard && npm run depsplit -- distribute bufring
npm run depsplit -- statement \$(stellar keys address depsplit-foundation)
EOF
