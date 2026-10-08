#!/usr/bin/env bash
# Tests unitaires "purs" (sans serveur) : paie, comptabilité, circuits de validation.
# Rapides, déterministes, à exécuter avant chaque commit sur les modules sensibles.
set -u
cd "$(dirname "$0")/.."

UNITS=(
  "src/payroll/engine.test.js"          # invariants moteur de paie (Sage-calibré)
  "src/payroll/engine.zang.test.js"     # bulletin réel ZANG, exact au franc
  "src/accounting/balanceModel.test.js" # balance format Sage, aucun solde négatif
  "src/workflowConfig.test.js"          # circuits configurables (correctif congé)
)

fails=0
for u in "${UNITS[@]}"; do
  printf "\n### %s\n" "$u"
  if node "$u"; then :; else fails=$((fails+1)); fi
done

echo "-----------------------------------------"
if [ "$fails" -eq 0 ]; then echo "UNIT TESTS: all suites passed"; else echo "UNIT TESTS: $fails suite(s) FAILED"; fi
exit $fails
