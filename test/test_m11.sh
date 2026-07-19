#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }
SADM=$(tok superadmin@sgrhp.io); ADM=$(tok admin@cible-rh.ci)

# super-admin exists and can list; regular admin cannot
[ -n "$SADM" ] && chk 1 1 "super-admin account seeded & can log in" || chk 0 1 "SADM login"
c=$(curl -s -o /dev/null -w '%{http_code}' $B/tenants -H "Authorization: Bearer $ADM"); chk $c 403 "tenant admin cannot access platform tenants"
N=$(curl -s $B/tenants -H "Authorization: Bearer $SADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 1 ] && chk 1 1 "seeded tenant (Cible RH) listed ($N)" || chk 0 1 "tenant listed"
M=$(curl -s $B/tenants/modules -H "Authorization: Bearer $SADM" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d), any(x["key"]=="payroll" for x in d))'); chk "$M" "6 True" "module catalogue (6, incl. payroll)"

# create with missing required -> 400
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/tenants -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"name":"Test"}'); chk $c 400 "missing required fields rejected"
# invalid NIU -> 400
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/tenants -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"name":"T","legalForm":"SARL","rccm":"RC/1","niu":"BADNIU","hqCity":"Douala","legalRep":"X","email":"a@b.cm"}'); chk $c 400 "invalid NIU format rejected"
# invalid legal form -> 400
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/tenants -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"name":"T","legalForm":"XYZ","rccm":"RC/1","niu":"M100000000001N","hqCity":"D","legalRep":"X","email":"a@b.cm"}'); chk $c 400 "invalid legal form rejected"

# valid create
R=$(curl -s -X POST $B/tenants -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"name":"ACME Cameroun","acronym":"ACME","legalForm":"SARL","sector":"BTP","rccm":"RC/DLA/2026/B/1234","niu":"M200000000009X","cnpsEmployer":"CN-77","shareCapital":"5000000","hqAddress":"Bonanjo","hqCity":"Douala","bp":"1000","phone":"+237 690000000","email":"contact@acme.cm","legalRep":"Jean Paul","modules":["payroll","invoicing"],"logo":"data:image/png;base64,iVBORw0KGgo="}')
TID=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
[ -n "$TID" ] && chk 1 1 "tenant created with full profile ($TID)" || chk 0 1 "create"
MODS=$(echo $R | python3 -c 'import sys,json;m=json.load(sys.stdin)["modules"];print("hr" in m and "careers" in m and "payroll" in m and "invoicing" in m)'); chk "$MODS" True "core modules kept + selected modules enabled"
LG=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["logo"].startswith("data:image/png"))'); chk "$LG" True "logo stored"
# duplicate NIU
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/tenants -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"name":"Dup","legalForm":"SA","rccm":"RC/2","niu":"M200000000009X","hqCity":"D","legalRep":"Y","email":"y@z.cm"}'); chk $c 409 "duplicate NIU rejected"

# module toggle: core cannot be removed
R=$(curl -s -X PUT $B/tenants/$TID/modules -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"modules":["stock"]}')
CORE=$(echo $R | python3 -c 'import sys,json;m=json.load(sys.stdin)["modules"];print("hr" in m and "careers" in m and "stock" in m)'); chk "$CORE" True "core modules stay on when toggling"

# suspend / reactivate
S=$(curl -s -X PUT $B/tenants/$TID/status -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"status":"SUSPENDED"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])'); chk "$S" "SUSPENDED" "tenant can be suspended"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/tenants/$TID/status -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"status":"NOPE"}'); chk $c 400 "invalid status rejected"

# audit
N=$(curl -s "$B/audit?objectType=Tenant" -H "Authorization: Bearer $SADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin))>=3)'); chk "$N" True "tenant operations audited"

echo; echo "RESULT: $pass passed, $fail failed"
