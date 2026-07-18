#!/usr/bin/env bash
# Full SGRHP test suite. Each suite runs against a FRESH, freshly-seeded server so
# state-changing tests (account lockout in m7, 2FA enrolment in m8, imports in m9)
# never leak into the next suite. Rate limiting is disabled for the harness only.
set -u
cd "$(dirname "$0")/.."

SUITES=(test_m1 test_m2 test_m3 test_m3b test_m3c test_m4 test_m4b test_m4c \
        test_m5 test_m6 test_m7 test_m8 test_m9)
total_pass=0; total_fail=0

start() {
  rm -rf data uploads/generated uploads/fiches uploads/decisions
  rm -f templates/*studio* templates/*plain* templates/[0-9]* 2>/dev/null
  RATE_LIMIT_PER_MIN=0 LOGIN_LIMIT=0 node src/server.js > /tmp/sgrhp-test.log 2>&1 &
  SRV=$!
  for i in $(seq 1 25); do curl -s http://localhost:4000/health >/dev/null 2>&1 && return; sleep 0.4; done
  echo "!! server failed to start" >&2
}
stop() {
  pkill -f "node src/server" 2>/dev/null
  kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
  # block until port 4000 is genuinely free, so the next suite can't hit a stale server
  for i in $(seq 1 40); do curl -s http://localhost:4000/health >/dev/null 2>&1 || return; sleep 0.25; done
  echo "!! port 4000 still busy after stop" >&2
}

for s in "${SUITES[@]}"; do
  start
  out=$(bash "test/$s.sh" 2>/dev/null | tail -1)
  stop
  p=$(echo "$out" | grep -o '[0-9]* passed' | grep -o '[0-9]*')
  f=$(echo "$out" | grep -o '[0-9]* failed' | grep -o '[0-9]*')
  total_pass=$((total_pass + ${p:-0})); total_fail=$((total_fail + ${f:-0}))
  printf "%-14s %s\n" "$s" "$out"
done

# Browser-free unit checks (no server needed)
for u in test_pg_adapter test_i18n; do
  out=$(node "test/$u.js" 2>/dev/null | tail -1)
  p=$(echo "$out" | grep -o '[0-9]* passed' | grep -o '[0-9]*')
  f=$(echo "$out" | grep -o '[0-9]* failed' | grep -o '[0-9]*')
  total_pass=$((total_pass + ${p:-0})); total_fail=$((total_fail + ${f:-0}))
  printf "%-14s %s\n" "$u" "$out"
done

echo "-----------------------------------------"
echo "TOTAL: $total_pass passed, $total_fail failed"
[ "$total_fail" -eq 0 ]
