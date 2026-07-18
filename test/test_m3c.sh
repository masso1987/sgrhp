#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); UI=$(tok ui@cible-rh.ci)
PF=$(curl -s $B/portfolios -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')

# CDD without end date rejected
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"A\",\"lastName\":\"B\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"C1\",\"cniExpiry\":\"2030-01-01\",\"contract\":{\"type\":\"CDD\"}}"); chk $c 400 "CDD without end date rejected"
# CDD with end date OK
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"A\",\"lastName\":\"B\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"C2\",\"cniExpiry\":\"2030-01-01\",\"contract\":{\"type\":\"CDD\",\"endDate\":\"2026-08-10\"}}"); chk $c 201 "CDD with end date created"
# CDI with end date -> end date nulled
E=$(curl -s -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"C\",\"lastName\":\"D\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"C3\",\"cniExpiry\":\"2030-01-01\",\"contract\":{\"type\":\"CDI\",\"endDate\":\"2027-01-01\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["contract"]["endDate"])'); chk "$E" None "CDI end date forced to unknown (null)"

# dashboard: all roles incl. UI; CDD ending appears
D=$(curl -s $B/dashboard -H "Authorization: Bearer $UI")
HC=$(echo $D | python3 -c 'import sys,json;print(json.load(sys.stdin)["headcount"]>=3)'); chk $HC True "dashboard accessible to UI role, headcount OK"
N=$(echo $D | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["cddEnding"])>=1)'); chk $N True "CDD ending ≤30d alert on dashboard"
N=$(echo $D | python3 -c 'import sys,json;d=json.load(sys.stdin);print("pendingCD" in d and "breaches" in d and "cniExpiring" in d)'); chk $N True "dashboard KPIs present"
echo; echo "RESULT: $pass passed, $fail failed"
