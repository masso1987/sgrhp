#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); CD=$(tok cd@cible-rh.ci); RJ=$(tok rj@cible-rh.ci); UI=$(tok ui@cible-rh.ci); ADM=$(tok admin@cible-rh.ci)
EMP=$(curl -s $B/employees -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')

# --- amendments ---
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/hr/$EMP/amendments -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"avenantType":"Avenant salarial","changes":{}}'); chk $c 400 "empty amendment rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/hr/$EMP/amendments -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"avenantType":"Avenant salarial","changes":{"firstName":"X"}}'); chk $c 400 "non-amendable field rejected"
A=$(curl -s -X POST $B/hr/$EMP/amendments -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"avenantType":"Avenant de catégorie","changes":{"category":"B3"},"effectiveDate":"2026-08-01","reason":"Advancement"}')
AID=$(echo $A | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
VER=$(echo $A | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])'); chk $VER 1 "amendment v1 created & submitted"
# not applied before approval
CAT=$(curl -s $B/employees/$EMP -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)["contract"]["category"])'); chk $CAT B2 "contract unchanged before validation"
# approve chain -> applied
curl -s -o /dev/null -X POST $B/documents/$AID/approve -H "Authorization: Bearer $CD"
curl -s -o /dev/null -X POST $B/documents/$AID/approve -H "Authorization: Bearer $RJ"
CAT=$(curl -s $B/employees/$EMP -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)["contract"]["category"])'); chk $CAT B3 "amendment applied after RJ approval (B2->B3)"
# version 2
VER=$(curl -s -X POST $B/hr/$EMP/amendments -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"avenantType":"Avenant de catégorie","changes":{"step":"4"}}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])'); chk $VER 2 "versioning: avenant n°2"

# --- decisions ---
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/hr/$EMP/decisions -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"type":"Invalid"}'); chk $c 400 "decision type must come from referential"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/hr/$EMP/decisions -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"type":"Avertissement","detail":"Retards répétés"}'); chk $c 201 "sanction recorded"
N=$(curl -s $B/hr/$EMP/decisions -H "Authorization: Bearer $CD" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); chk $N 1 "CD can view decisions"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/hr/$EMP/decisions -H "Authorization: Bearer $UI" -H 'Content-Type: application/json' -d '{"type":"Promotion"}'); chk $c 403 "UI cannot record decisions"

# --- leave ---
BAL=$(curl -s $B/hr/$EMP/leave -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)["balance"]["remaining"])')
echo "  (balance: $BAL days)"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/hr/$EMP/leave -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"leaveType":"Congé annuel","startDate":"2026-08-01","endDate":"2026-12-31"}'); chk $c 400 "leave exceeding balance rejected"
L=$(curl -s -X POST $B/hr/$EMP/leave -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"leaveType":"Congé annuel","startDate":"2026-08-03","endDate":"2026-08-07"}')
LID=$(echo $L | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
D=$(echo $L | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["days"])'); chk $D 5 "5-day leave request submitted"
curl -s -o /dev/null -X POST $B/documents/$LID/approve -H "Authorization: Bearer $CD"
curl -s -o /dev/null -X POST $B/documents/$LID/approve -H "Authorization: Bearer $RJ"
B2=$(curl -s $B/hr/$EMP/leave -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)["balance"]["taken"])'); chk $B2 5 "balance deducted after approval (5 days taken)"
# leave appears in CD queue like any doc
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/hr/$EMP/leave -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"leaveType":"Congé annuel","startDate":"2026-09-01","endDate":"2026-09-02"}'); chk $c 403 "CD cannot create leave requests"

echo; echo "RESULT: $pass passed, $fail failed"
