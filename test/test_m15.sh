B=http://localhost:4000/api
pass=0;fail=0
chk(){ if [ "$1" = "$2" ];then pass=$((pass+1));echo "PASS: $3";else fail=$((fail+1));echo "FAIL: $3 (got $1 want $2)";fi; }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }
GPF=$(tok gpf@cible-rh.ci); CD=$(tok cd@cible-rh.ci); RJ=$(tok rj@cible-rh.ci); ADM=$(tok admin@cible-rh.ci)
# customise the rejected template so we can detect it end-to-end
curl -s -o /dev/null -X PUT $B/settings/email/templates -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"rejected":{"subjectFr":"REJETE-CUSTOM {{title}}","bodyFr":"Motif: {{reason}} par {{validator}}"}}'
# build & submit a template doc
TPL=$(curl -s $B/templates -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print([t for t in json.load(sys.stdin) if "CDI" in t["name"]][0]["id"])')
EMP=$(curl -s $B/employees -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
V='{"salary_base":"200000","allowance_transport":"20000","allowance_housing":"30000","allowance_dirt":"5000","salary_gross":"255000","contract_position":"Tech","contract_workCity":"Douala","employee_residence":"Cocody","collective_agreement":"Convention","client_company":"ENEO"}'
DOC=$(curl -s -X POST $B/documents/from-template -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"templateId\":\"$TPL\",\"employeeId\":\"$EMP\",\"values\":$V}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
# CD sees a "submitted" in-app notification
N=$(curl -s $B/notifications -H "Authorization: Bearer $CD" | python3 -c 'import sys,json;print(json.load(sys.stdin)["unread"]>=1)'); chk "$N" True "CD notified on submission (in-app)"
# reject -> initiator gets the CUSTOM template text
curl -s -o /dev/null -X POST $B/documents/$DOC/reject -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"reason":"RIB illisible"}'
S=$(curl -s $B/notifications -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(any("REJETE-CUSTOM" in n["subject"] for n in d["items"]))'); chk "$S" True "rejection uses the custom template subject"
BD=$(curl -s $B/notifications -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(any("RIB illisible" in (n["body"] or "") and "CD" in (n["body"] or "") for n in d["items"]))'); chk "$BD" True "rejection body fills {{reason}} and {{validator}}"
# resubmit -> approve chain -> validated notification to initiator
curl -s -o /dev/null -X POST $B/documents/$DOC/resubmit -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"values":{}}'
curl -s -o /dev/null -X POST $B/documents/$DOC/approve -H "Authorization: Bearer $CD"
curl -s -o /dev/null -X POST $B/documents/$DOC/approve -H "Authorization: Bearer $RJ"
VN=$(curl -s $B/notifications -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(any("validé" in (n["subject"] or "").lower() or "valid" in (n["subject"] or "").lower() for n in d["items"]))'); chk "$VN" True "initiator notified on final validation"
echo;echo "RESULT: $pass passed, $fail failed"
