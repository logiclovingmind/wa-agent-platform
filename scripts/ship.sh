#!/usr/bin/env bash
#
# The whole gate and the whole deploy, in the order that is safe.
#
#   ./scripts/ship.sh "commit message"          # gate, commit, push, migrate, deploy
#   ./scripts/ship.sh --seed "commit message"   # ... and re-seed the live demo data
#   ./scripts/ship.sh --check "commit message"  # stop after the gate, deploy nothing
#
# The order is not arbitrary. The dashboard reads live Supabase even from localhost, so
# a migration has to land before the build that depends on it — a dashboard deployed
# first is a dashboard erroring in front of whoever is looking at it.
set -euo pipefail
cd "$(dirname "$0")/.."

SEED=false
CHECK_ONLY=false
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --seed) SEED=true ;;
    --check) CHECK_ONLY=true ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

MESSAGE="${1:-}"
if [[ -z "$MESSAGE" && "$CHECK_ONLY" == false ]]; then
  echo "usage: ./scripts/ship.sh [--seed] [--check] \"commit message\"" >&2
  exit 1
fi

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }

step "lint"
pnpm lint

step "typecheck"
pnpm typecheck

# This wipes the local cluster: the db project truncates to seed its two orgs. The demo
# data is put back at the end, which is why re-seeding is not optional.
step "tests"
pnpm test

step "dashboard build"
pnpm --filter @wa/dashboard build

if [[ "$CHECK_ONLY" == true ]]; then
  step "check only — nothing deployed"
  psql "${DATABASE_URL:-postgresql://postgres@127.0.0.1:54322/wa_agent}" -q -f scripts/demo-seed.sql
  echo "local demo data restored"
  exit 0
fi

step "commit"
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git commit -m "$MESSAGE"
else
  echo "nothing to commit — shipping what is already on HEAD"
fi

step "push"
git push

step "migrate (live)"
if [[ "$SEED" == true ]]; then
  gh workflow run migrate.yml -f seed_demo=true
else
  gh workflow run migrate.yml
fi

# The run id is not returned by `workflow run`, and asking too early gets the previous
# run. Give Actions a moment to register this one.
sleep 8
RUN_ID="$(gh run list --workflow=migrate.yml --limit 1 --json databaseId -q '.[0].databaseId')"
echo "run $RUN_ID"
gh run watch "$RUN_ID" --exit-status >/dev/null
echo "migration applied"

step "deploy dashboard"
pnpm deploy:dashboard

step "deploy api"
pnpm deploy:api

# The check that has caught four regressions here: Supabase grants EXECUTE on every new
# public function to anon regardless of any `revoke ... from public`, and a revoke that
# was never called with the anon key has been wrong more often than it has been right.
step "anon lockout"
set -a; . ./dashboard/.env; set +a
NIL="00000000-0000-0000-0000-000000000000"
FAILED=false

# Real arguments, not `{}`: PostgREST resolves an RPC by its argument names, and an
# empty body answers "could not find the function" for every one of these — which reads
# as a pass and proves nothing.
check_anon() {
  local fn="$1" body="$2" out
  out="$(curl -s -X POST "$VITE_SUPABASE_URL/rest/v1/rpc/$fn" \
    -H "apikey: $VITE_SUPABASE_ANON_KEY" \
    -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" -d "$body")"
  if [[ "$out" == *42501* ]]; then
    echo "  $fn — denied to anon"
  else
    echo "  $fn — NOT DENIED: $out" >&2
    FAILED=true
  fi
}

check_anon search_everything "{\"p_org_id\":\"$NIL\",\"p_query\":\"anything\"}"
check_anon admin_orgs '{}'
check_anon org_month_spend "{\"p_org_id\":\"$NIL\"}"
# Takes no arguments, so `{}` genuinely resolves it here — unlike the three above, where
# an empty body would answer "could not find the function" and prove nothing.
check_anon demo_reset '{}'
check_anon demo_setup_save '{"p_label":"anything"}'
check_anon demo_setup_load "{\"p_id\":\"$NIL\"}"
# free_slots is granted to `authenticated` (the dashboard shows the diary), so this only
# asserts the anon half. book_appointment is revoked from everyone: it books across orgs
# by signature and the Worker calls it as service_role.
check_anon free_slots "{\"p_org_id\":\"$NIL\"}"
check_anon book_appointment "{\"p_org_id\":\"$NIL\",\"p_conversation_id\":null,\"p_starts_at\":\"2030-01-01T00:00:00Z\"}"

if [[ "$FAILED" == true ]]; then
  echo "anon can reach a function it should not. Fix before telling anyone this shipped." >&2
  exit 1
fi

step "restore local demo data"
psql "${DATABASE_URL:-postgresql://postgres@127.0.0.1:54322/wa_agent}" -q -f scripts/demo-seed.sql

step "shipped"
