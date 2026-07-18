#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); CD=$(tok cd@cible-rh.ci); RJ=$(tok rj@cible-rh.ci); UI=$(tok ui@cible-rh.ci); ADM=$(tok admin@cible-rh.ci)

PF=$(curl -s $B/portfolios -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print([p for p in json.load(sys.stdin) if p["name"]=="Industrial Clients"][0]["id"])')
EID=$(curl -s -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"Wf\",\"lastName\":\"TEST\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1992-05-05\",\"cniNumber\":\"CI777\",\"cniExpiry\":\"2031-01-01\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 1. submission gate: docs incomplete
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees/$EID/submit -H "Authorization: Bearer $GPF"); chk $c 400 "submit blocked while docs missing"

# upload the 5 required docs for Industrial Clients (III,IV,V,IX,X)
echo x > /tmp/f.pdf
for D in I III IV VII IX X XI XVI; do curl -s -o /dev/null -X POST $B/employees/$EID/files -H "Authorization: Bearer $GPF" -F docType=$D -F file=@/tmp/f.pdf; done
curl -s -o /dev/null -X POST $B/employees/$EID/files -H "Authorization: Bearer $GPF" -F docType=V -F expiryDate=2031-01-01 -F file=@/tmp/f.pdf

# 2. submit OK
R=$(curl -s -X POST $B/employees/$EID/submit -H "Authorization: Bearer $GPF")
DOC=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
ST=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
chk $ST SUBMITTED "submit OK -> SUBMITTED, doc $DOC"
# double submit blocked
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees/$EID/submit -H "Authorization: Bearer $GPF"); chk $c 409 "double submit -> 409"

# 3. queue visibility: in CD queue, not in RJ queue
N=$(curl -s $B/documents/queue -H "Authorization: Bearer $CD" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); chk $N 1 "doc in CD queue"
N=$(curl -s $B/documents/queue -H "Authorization: Bearer $RJ" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); chk $N 0 "not yet in RJ queue"

# 4. stage enforcement: RJ cannot decide CD stage; UI cannot approve at all
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/documents/$DOC/approve -H "Authorization: Bearer $RJ"); chk $c 403 "RJ cannot approve at CD stage"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/documents/$DOC/approve -H "Authorization: Bearer $UI"); chk $c 403 "UI cannot approve"

# 5. CD reject without reason -> 400; with reason -> back to DRAFT
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/documents/$DOC/reject -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{}'); chk $c 400 "reject without reason -> 400"
ST=$(curl -s -X POST $B/documents/$DOC/reject -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"reason":"RIB illegible"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])'); chk $ST DRAFT "reject with reason -> DRAFT"
# GPF notified with the comment
N=$(curl -s $B/notifications -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)["unread"])'); [ "$N" -ge 1 ] && chk 1 1 "initiator notified of rejection" || chk 0 1 "initiator notified"

# 6. resubmit -> cycle 2
CY=$(curl -s -X POST $B/employees/$EID/submit -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)["cycle"])'); chk $CY 2 "resubmission counted (cycle 2)"

# 7. CD approve -> RJ queue; RJ approve -> GENERATED
curl -s -o /dev/null -X POST $B/documents/$DOC/approve -H "Authorization: Bearer $CD"
N=$(curl -s $B/documents/queue -H "Authorization: Bearer $RJ" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); chk $N 1 "after CD approval doc in RJ queue"
ST=$(curl -s -X POST $B/documents/$DOC/approve -H "Authorization: Bearer $RJ" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])'); chk $ST GENERATED "RJ approval -> GENERATED"

# 8. UI can list and download; download is logged as PRINTED/DOWNLOADED
N=$(curl -s $B/documents/generated -H "Authorization: Bearer $UI" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 1 ] && chk 1 1 "UI sees generated docs" || chk 0 1 "UI sees generated docs"
c=$(curl -s -o /dev/null -w '%{http_code}' "$B/documents/$DOC/download?print=1" -H "Authorization: Bearer $UI"); chk $c 200 "UI prints document"
N=$(curl -s "$B/audit?action=PRINTED" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 1 ] && chk 1 1 "print action logged in audit" || chk 0 1 "print logged"
# GPF cannot download generated docs route? (GPF excluded)
c=$(curl -s -o /dev/null -w '%{http_code}' $B/documents/generated -H "Authorization: Bearer $GPF"); chk $c 403 "GPF denied on generated list"

echo; echo "RESULT: $pass passed, $fail failed"
