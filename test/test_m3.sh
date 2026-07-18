#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); CD=$(tok cd@cible-rh.ci); RJ=$(tok rj@cible-rh.ci); UI=$(tok ui@cible-rh.ci); ADM=$(tok admin@cible-rh.ci)

# 1. seeded templates registered
N=$(curl -s $B/templates -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(len([t for t in json.load(sys.stdin) if "CD" in t["name"]]))'); chk $N 2 "CRHE contract templates auto-registered"
TPL=$(curl -s $B/templates -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print([t for t in json.load(sys.stdin) if "CDD" in t["name"]][0]["id"])')
EMP=$(curl -s $B/employees -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')

# 2. resolve: auto-fill vs missing
R=$(curl -s $B/templates/$TPL/resolve/$EMP -H "Authorization: Bearer $GPF")
AF=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["resolved"].get("employee_fullName",""))'); chk "$AF" "Karim OUATTARA" "employee_fullName auto-filled"
MS=$(echo $R | python3 -c 'import sys,json;print("mission_duration" in json.load(sys.stdin)["missing"])'); chk $MS True "non-resolvable fields detected as missing"

# 3. create without values -> 422 listing missing
c=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST $B/documents/from-template -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"templateId\":\"$TPL\",\"employeeId\":\"$EMP\"}"); chk $c 422 "incomplete data -> 422"
M=$(python3 -c 'import json;print(len(json.load(open("/tmp/r.json"))["missing"])>0)'); chk $M True "missing list returned to build the form"

# 4. create with all values -> submitted
V='{"salary_base":"250 000","allowance_transport":"25 000","allowance_housing":"40 000","allowance_dirt":"10 000","salary_gross":"325 000","contract_position":"Technicien electricien","contract_workCity":"Douala","contract_endDate":"01/03/2027","employee_residence":"Cocody, Abidjan","collective_agreement":"Convention collective nationale du Commerce","client_company":"ENEO","mission_duration":"12 mois"}'
R=$(curl -s -X POST $B/documents/from-template -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"templateId\":\"$TPL\",\"employeeId\":\"$EMP\",\"values\":$V}")
DOC=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
ST=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])'); chk $ST SUBMITTED "complete data -> created & SUBMITTED ($DOC)"

# 5. reject -> correct -> resubmit cycle 2
curl -s -o /dev/null -X POST $B/documents/$DOC/reject -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"reason":"Wrong salary"}'
CY=$(curl -s -X POST $B/documents/$DOC/resubmit -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"values":{"salary_base":"260 000"}}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["cycle"])'); chk $CY 2 "corrected resubmission -> cycle 2"

# 6. approve chain -> GENERATED docx
curl -s -o /dev/null -X POST $B/documents/$DOC/approve -H "Authorization: Bearer $CD"
G=$(curl -s -X POST $B/documents/$DOC/approve -H "Authorization: Bearer $RJ")
ST=$(echo $G | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])'); chk $ST GENERATED "RJ approval -> GENERATED"
FN=$(echo $G | python3 -c 'import sys,json;print(json.load(sys.stdin)["generatedFile"])'); [[ "$FN" == *.docx ]] && chk 1 1 "output is a Word file ($FN)" || chk 0 1 "output is docx"

# 7. UI downloads; content check: values merged, no {{ left
curl -s -o /tmp/gen.docx "$B/documents/$DOC/download" -H "Authorization: Bearer $UI"
unzip -p /tmp/gen.docx word/document.xml > /tmp/gen.xml
grep -q "260 000" /tmp/gen.xml && chk 1 1 "corrected salary merged into final contract" || chk 0 1 "salary merged"
grep -q "Karim OUATTARA" /tmp/gen.xml && chk 1 1 "employee name merged" || chk 0 1 "name merged"
grep -q "{{" /tmp/gen.xml && chk 1 0 "no unresolved placeholders" || chk 0 0 "no unresolved placeholders"

# 8. ADM upload: docx without tags rejected; GPF cannot upload
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/templates -H "Authorization: Bearer $ADM" -F name=plain -F file=@/tmp/plain.docx); chk $c 400 "template without placeholders rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/templates -H "Authorization: Bearer $GPF" -F name=x -F file=@/tmp/plain.docx); chk $c 403 "GPF cannot upload templates"

echo; echo "RESULT: $pass passed, $fail failed"
