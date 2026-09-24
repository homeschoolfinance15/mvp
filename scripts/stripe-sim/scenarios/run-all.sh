#!/usr/bin/env bash
# Full payment run: all six batches, fresh fixtures, in the order they need.
# LOCAL ONLY: needs `supabase start` and Docker. Usage: bash scripts/stripe-sim/scenarios/run-all.sh
H="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$H/../../.." && pwd)"
P="$REPO/scripts/stripe-sim/out"; mkdir -p "$P"
cd "$REPO"

wait_fn() { for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:54321/functions/v1/stripe-webhook)" = 400 ] && return 0; sleep 2; done; echo "functions never came up"; exit 1; }
serve() { npx supabase functions serve --no-verify-jwt --env-file "$H/$1" > "$P/functions-$1.out" 2>&1 & FN=$!; sleep 3; wait_fn; }
unserve() { kill $FN 2>/dev/null; docker stop supabase_edge_runtime_amazing >/dev/null 2>&1; sleep 2; }
count() { echo "$1 pass $(grep -c ^PASS "$P/$2") fail $(grep -c ^FAIL "$P/$2")"; grep ^FAIL "$P/$2" | cut -c1-300; }

docker stop supabase_edge_runtime_amazing >/dev/null 2>&1
SIM_LOG="$P/stripe-requests.jsonl" node scripts/stripe-sim/server.mjs > "$P/sim.out" 2> "$P/sim.err" & SIM=$!
serve env.sim

cd "$H"
node fixtures.mjs > "$P/fixtures.log" 2>&1 || { cat "$P/fixtures.log"; exit 1; }
node scen1.mjs > "$P/run1.log" 2>&1; count b1 run1.log
node scen2.mjs > "$P/run2.log" 2>&1; count b2 run2.log
node scen3a.mjs > "$P/run3a.log" 2>&1
cd "$REPO"; unserve; cd "$H"
node scen3b.mjs > "$P/run3b.log" 2>&1; echo "b3b deliveries lost: $(grep -cE '"status":5[0-9][0-9]' "$P/run3b.log") of 2"
cd "$REPO"; serve env.sim.fee500; cd "$H"
node scen3c.mjs > "$P/run3.log" 2>&1; count b3 run3.log
cd "$REPO"; unserve; serve env.sim; cd "$H"
node scen4.mjs > "$P/run4.log" 2>&1; count b4 run4.log
node scen5.mjs > "$P/run5.log" 2>&1; count b5 run5.log
node scen6.mjs > "$P/run6.log" 2>&1; count b6 run6.log; grep -E '^[A-Za-z]*Error' "$P/run6.log" | head -3
node ledger.mjs > /dev/null 2>&1; tail -1 "$P/ledger.md" | grep -o 'Mismatch.*'

cd "$REPO"; unserve; kill $SIM 2>/dev/null
