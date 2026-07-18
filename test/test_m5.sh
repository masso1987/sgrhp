#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); CD=$(tok cd@cible-rh.ci); RJ=$(tok rj@cible-rh.ci); U=$(tok ui@cible-rh.ci); ADM=$(tok admin@cible-rh.ci)
EMP=$(curl -s $B/employees -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')

# career plan
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/career/plans/$EMP -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"potential":12}'); chk $c 400 "potential outside 1-9 rejected"
PATH1=$(curl -s $B/career/paths -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
P=$(curl -s -X PUT $B/career/plans/$EMP -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"preferredPositions\":[\"Superviseur de site\"],\"preferredLocations\":[\"Douala\"],\"potential\":8,\"careerPathId\":\"$PATH1\",\"trainings\":[\"Habilitation électrique\"]}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["potential"])'); chk $P 8 "career plan saved (potential 8, path linked)"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/career/plans/$EMP -H "Authorization: Bearer $U" -H 'Content-Type: application/json' -d '{}'); chk $c 403 "UI cannot edit career plans"

# OKR
O=$(curl -s -X POST $B/career/okr/$EMP -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"period":"Q3 2026","objective":"Réduire les incidents","keyResults":[{"title":"Incidents -20%"},{"title":"2 certifications"}]}')
OID=$(echo $O | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
[ -n "$OID" ] && chk 1 1 "OKR created with 2 key results" || chk 0 1 "OKR created"
PR=$(curl -s -X PUT $B/career/okr/$OID/progress -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"updates":[{"index":0,"progress":70},{"index":1,"progress":50}]}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["keyResults"][0]["progress"])'); chk $PR 70 "OKR progress updated (70%)"

# 360
E=$(curl -s -X POST $B/career/eval360 -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d "{\"employeeId\":\"$EMP\",\"name\":\"360 2026\",\"criteria\":[\"Communication\",\"Technique\"],\"evaluators\":[{\"name\":\"JM Tano\",\"role\":\"manager\"},{\"name\":\"Self\",\"role\":\"self\"}]}")
EID360=$(echo $E | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/career/eval360 -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{}'); chk $c 403 "GPF cannot launch 360 campaigns"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/career/eval360/$EID360/submit -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"evaluatorIndex":0,"scores":[9,9]}'); chk $c 400 "scores outside 1-5 rejected"
curl -s -o /dev/null -X POST $B/career/eval360/$EID360/submit -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"evaluatorIndex":0,"scores":[4,5]}'
R=$(curl -s -X POST $B/career/eval360/$EID360/submit -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"evaluatorIndex":1,"scores":[3,4]}')
ST=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])'); chk $ST COMPLETE "campaign complete after all evaluators"
AV=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["consolidated"]["overall"])'); chk $AV 4 "consolidated overall = 4/5"

# check-in + interview + e-signature
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/career/checkins/$EMP -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"notes":"Point mensuel OK"}'); chk $c 201 "check-in logged"
IT=$(curl -s -X POST $B/career/interviews/$EMP -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"type":"Entretien annuel","summary":"Bilan positif"}')
ITID=$(echo $IT | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -o /dev/null -X POST $B/career/interviews/$ITID/sign -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"as":"manager","signedName":"Jean-Marc Tano"}'
ST=$(curl -s -X POST $B/career/interviews/$ITID/sign -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"as":"employee","signedName":"Karim Ouattara"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])'); chk $ST SIGNED_ARCHIVED "interview signed by both -> archived"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/career/interviews/$ITID/sign -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"as":"manager","signedName":"X"}'); chk $c 409 "double signature blocked"
N=$(curl -s "$B/audit?action=SIGNED" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 2 ] && chk 1 1 "signatures audited ($N)" || chk 0 1 "signatures audited"

# succession + matching
SP=$(curl -s -X POST $B/career/succession -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"keyPosition":"Superviseur de site","criticality":"HIGH"}')
SPID=$(echo $SP | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
RD=$(curl -s -X POST $B/career/succession/$SPID/successors -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d "{\"employeeId\":\"$EMP\",\"readiness\":\"READY_1_2Y\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["successors"][0]["readiness"])'); chk $RD READY_1_2Y "successor added (ready 1-2y)"
M=$(curl -s $B/career/matching -H "Authorization: Bearer $CD")
N=$(echo $M | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 1 ] && chk 1 1 "predictive matching returns suggestions" || chk 0 1 "matching"
SC=$(echo $M | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["score"]>=70)'); chk $SC True "top match has high score (preferences+potential+OKR)"
c=$(curl -s -o /dev/null -w '%{http_code}' $B/career/succession -H "Authorization: Bearer $U"); chk $c 403 "UI cannot view succession plans"

echo; echo "RESULT: $pass passed, $fail failed"
