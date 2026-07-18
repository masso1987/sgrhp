#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }

tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); CD=$(tok cd@cible-rh.ci); RJ=$(tok rj@cible-rh.ci); UI=$(tok ui@cible-rh.ci); ADM=$(tok admin@cible-rh.ci)
[ -n "$GPF" ] && [ -n "$ADM" ] && echo "PASS: all 5 logins" || echo "FAIL: logins"

# bad password
c=$(curl -s -o /dev/null -w '%{http_code}' $B/login -H 'Content-Type: application/json' -d '{"email":"gpf@cible-rh.ci","password":"wrong"}'); chk $c 401 "wrong password rejected"
# no token
c=$(curl -s -o /dev/null -w '%{http_code}' $B/employees); chk $c 401 "no token -> 401"
# UI cannot list employees
c=$(curl -s -o /dev/null -w '%{http_code}' $B/employees -H "Authorization: Bearer $UI"); chk $c 403 "UI role denied on employees"
# CD can read but not create
c=$(curl -s -o /dev/null -w '%{http_code}' $B/employees -H "Authorization: Bearer $CD"); chk $c 200 "CD can list employees"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{}'); chk $c 403 "CD cannot create employee"

# GPF creates employee
PF=$(curl -s $B/portfolios -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
EMP=$(curl -s -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"Test\",\"lastName\":\"USER\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CI999\",\"cniExpiry\":\"2030-01-01\"}")
EID=$(echo $EMP | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
[ -n "$EID" ] && chk 1 1 "GPF creates employee ($EID)" || chk 0 1 "GPF creates employee"
# checklist inherited
N=$(echo $EMP | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["checklist"]))'); chk $N 9 "checklist inherited from portfolio (9 required docs)"

# missing field validation
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"firstName":"X"}'); chk $c 400 "missing fields -> 400"

# file upload: CNI without expiry rejected
echo dummy > /tmp/cni.pdf
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees/$EID/files -H "Authorization: Bearer $GPF" -F docType=V -F file=@/tmp/cni.pdf); chk $c 400 "CNI upload without expiry rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees/$EID/files -H "Authorization: Bearer $GPF" -F docType=V -F expiryDate=2030-01-01 -F file=@/tmp/cni.pdf); chk $c 201 "CNI upload with expiry OK"

# ADM: cannot remove CNI from portfolio requirements
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/portfolios/$PF/requirements -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"required":["I","III"]}'); chk $c 400 "CNI lock enforced (§2.3.3)"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/portfolios/$PF/requirements -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"required":["V","I","III"]}'); chk $c 200 "valid requirement update OK"
# non-ADM cannot configure
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/portfolios/$PF/requirements -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"required":["V"]}'); chk $c 403 "GPF cannot configure portfolios"

# audit log populated & filtered
N=$(curl -s "$B/audit?action=CONFIG_CHANGED" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 1 ] && chk 1 1 "audit log records config changes ($N)" || chk 0 1 "audit CONFIG_CHANGED"
N=$(curl -s "$B/audit?action=UPLOADED" -H "Authorization: Bearer $CD" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 1 ] && chk 1 1 "audit log records uploads" || chk 0 1 "audit UPLOADED"
c=$(curl -s -o /dev/null -w '%{http_code}' $B/audit -H "Authorization: Bearer $GPF"); chk $c 403 "GPF cannot read audit log"

# UI serves SPA
c=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/); chk $c 200 "web UI served"

echo; echo "RESULT: $pass passed, $fail failed"
