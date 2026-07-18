#!/usr/bin/env bash
# Runs the full SGRHP test suite against a freshly started server.
set -u
cd "$(dirname "$0")/.."
rm -rf data uploads/generated uploads/fiches uploads/decisions
rm -f templates/*studio* templates/*plain* templates/[0-9]* 2>/dev/null
RATE_LIMIT_PER_MIN=0 LOGIN_LIMIT=0 node src/server.js > /tmp/sgrhp-test.log 2>&1 &
SRV=$!
sleep 3
total_pass=0; total_fail=0
for t in test/test_m1.sh test/test_m2.sh test/test_m3.sh test/test_m3b.sh test/test_m3c.sh \
         test/test_m4.sh test/test_m4b.sh test/test_m4c.sh test/test_m5.sh test/test_m6.sh test/test_m7.sh; do
  out=$(bash "$t" 2>/dev/null | tail -1)
  p=$(echo "$out" | grep -o '[0-9]* passed' | grep -o '[0-9]*')
  f=$(echo "$out" | grep -o '[0-9]* failed' | grep -o '[0-9]*')
  total_pass=$((total_pass + ${p:-0})); total_fail=$((total_fail + ${f:-0}))
  printf "%-22s %s\n" "$(basename $t)" "$out"
done
kill $SRV 2>/dev/null
echo "-----------------------------------------"
echo "TOTAL: $total_pass passed, $total_fail failed"
[ "$total_fail" -eq 0 ]
