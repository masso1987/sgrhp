#!/bin/sh
# Tests unitaires "purs" (sans serveur) : paie, comptabilité, circuits, pointage.
# POSIX sh (compatible Alpine/BusyBox dans le conteneur Docker, et bash en local).
set -u
cd "$(dirname "$0")/.."

UNITS="src/payroll/engine.test.js \
src/payroll/engine.zang.test.js \
src/accounting/balanceModel.test.js \
src/workflowConfig.test.js \
src/attendanceTime.test.js"

fails=0
for u in $UNITS; do
  printf "\n### %s\n" "$u"
  if node "$u"; then :; else fails=$((fails + 1)); fi
done

echo "-----------------------------------------"
if [ "$fails" -eq 0 ]; then echo "UNIT TESTS: all suites passed"; else echo "UNIT TESTS: $fails suite(s) FAILED"; fi
exit "$fails"
