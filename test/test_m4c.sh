#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); ADM=$(tok admin@cible-rh.ci); RJ=$(tok rj@cible-rh.ci)
PF=$(curl -s $B/portfolios -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')

# 1. unique CNI / CNPS
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"Dup\",\"lastName\":\"CNI\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CI00248837\",\"cniExpiry\":\"2030-01-01\"}"); chk $c 409 "duplicate CNI rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"Dup\",\"lastName\":\"CNPS\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CIXNEW\",\"cniExpiry\":\"2030-01-01\",\"cnpsNumber\":\"118-224-587\"}"); chk $c 409 "duplicate CNPS rejected"

# 2. GPF cannot create in unlinked portfolio
NP=$(curl -s -X POST $B/portfolios -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"name":"Unlinked PF"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"X\",\"lastName\":\"Y\",\"portfolioId\":\"$NP\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CIZZ\",\"cniExpiry\":\"2030-01-01\"}"); chk $c 403 "GPF blocked on portfolio not linked to them"

# 3. emergency contact name+phone, category from referential
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"C\",\"lastName\":\"K\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CIQ1\",\"cniExpiry\":\"2030-01-01\",\"contract\":{\"type\":\"CDI\",\"category\":\"Z9\"}}"); chk $c 400 "unknown category rejected"
E=$(curl -s -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"Cat\",\"lastName\":\"OK\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CIQ2\",\"cniExpiry\":\"2030-01-01\",\"emergencyName\":\"Awa K\",\"emergencyPhone\":\"+237 699 11 22 33\",\"contract\":{\"type\":\"CDI\",\"category\":\"C1\"}}")
EN=$(echo $E | python3 -c 'import sys,json;e=json.load(sys.stdin);print(e["emergencyName"],e["emergencyPhone"],e["contract"]["category"])'); chk "$EN" "Awa K +237 699 11 22 33 C1" "emergency name+phone and category stored"
EID=$(echo $E | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 4. conventions seeded, one per collective agreement, portfolios linked
N=$(curl -s $B/config/conventions -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[ "$N" -ge 4 ] && chk 1 1 "conventions seeded ($N)" || chk 0 1 "conventions seeded"
CNV=$(curl -s $B/portfolios -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["conventionId"])')
[ "$CNV" != "None" ] && chk 1 1 "portfolio linked to a convention" || chk 0 1 "portfolio-convention link"

# 5. per-convention grid figures drive salary_base
CNV2=$(curl -s $B/config/conventions -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(json.load(sys.stdin)[1]["id"])')
curl -s -o /dev/null -X PUT $B/config/conventions/$CNV2/grid -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"grid":[{"category":"C1","baseSalary":999000}]}'
curl -s -o /dev/null -X PUT $B/portfolios/$PF/convention -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d "{\"conventionId\":\"$CNV2\"}"
TPL=$(curl -s $B/templates -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print([t for t in json.load(sys.stdin) if "CDI" in t["name"]][0]["id"])')
R=$(curl -s $B/templates/$TPL/resolve/$EID -H "Authorization: Bearer $GPF")
SB=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["resolved"].get("salary_base"))'); chk "$SB" "999 000" "salary_base from the portfolio's convention grid"
CA=$(echo $R | python3 -c 'import sys,json;print("collective" in json.load(sys.stdin)["resolved"].get("collective_agreement","").lower() or "Convention" in json.load(sys.stdin2) if False else "Convention" in json.load(sys.stdin)["resolved"].get("collective_agreement",""))' 2>/dev/null)
CA=$(echo $R | python3 -c 'import sys,json;print("Convention" in json.load(sys.stdin)["resolved"].get("collective_agreement",""))'); chk "$CA" True "collective_agreement auto-filled from portfolio convention"
# RJ cannot edit convention grids
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/config/conventions/$CNV2/grid -H "Authorization: Bearer $RJ" -H 'Content-Type: application/json' -d '{"grid":[{"category":"C1","baseSalary":1}]}'); chk $c 403 "RJ cannot edit convention figures"

echo; echo "RESULT: $pass passed, $fail failed"
