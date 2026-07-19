B=http://localhost:4000/api
pass=0;fail=0
chk(){ if [ "$1" = "$2" ];then pass=$((pass+1));echo "PASS: $3";else fail=$((fail+1));echo "FAIL: $3 (got $1 want $2)";fi; }
SADM=$(curl -s $B/login -H 'Content-Type: application/json' -d '{"email":"superadmin@sgrhp.io","password":"Superadmin2026"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
# overview
O=$(curl -s $B/tenants/stats/overview -H "Authorization: Bearer $SADM")
echo "$O" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("tenants",d["tenants"],"users",d["totalUsers"],"emps",d["totalEmployees"],"modules",len(d["moduleAdoption"]))'
T=$(echo "$O" | python3 -c 'import sys,json;print(json.load(sys.stdin)["tenants"]>=1)');chk "$T" True "platform overview"
# create tenant WITH admin
R=$(curl -s -X POST $B/tenants -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"name":"Beta SARL","legalForm":"SARL","rccm":"RC/DLA/2026/B/9","niu":"M300000000001Z","hqCity":"Yaoundé","legalRep":"Paul B","email":"c@beta.cm","adminEmail":"admin@beta.cm","adminName":"Admin Beta"}')
TID=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
TP=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["admin"]["tempPassword"])')
[ -n "$TP" ] && chk 1 1 "tenant created with admin (temp pw: $TP)" || chk 0 1 "admin provisioned"
# the new admin can log in
NT=$(curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"admin@beta.cm\",\"password\":\"$TP\"}" | python3 -c 'import sys,json;print(bool(json.load(sys.stdin).get("token")))')
chk "$NT" True "provisioned tenant admin can log in"
# list tenant users
N=$(curl -s $B/tenants/$TID/users -H "Authorization: Bearer $SADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
chk "$N" 1 "tenant has its provisioned admin"
# add another user to tenant
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/tenants/$TID/users -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"email":"gpf@beta.cm","fullName":"GPF Beta","role":"GPF"}');chk $c 201 "add GPF to tenant"
# reset password
RP=$(curl -s -X POST $B/tenants/$TID/users/$(curl -s $B/tenants/$TID/users -H "Authorization: Bearer $SADM" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')/reset -H "Authorization: Bearer $SADM" | python3 -c 'import sys,json;print(bool(json.load(sys.stdin).get("tempPassword")))')
chk "$RP" True "reset tenant admin password"
# regular admin can't reach platform
ADM=$(curl -s $B/login -H 'Content-Type: application/json' -d '{"email":"admin@cible-rh.ci","password":"demo123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
c=$(curl -s -o /dev/null -w '%{http_code}' $B/tenants/stats/overview -H "Authorization: Bearer $ADM");chk $c 403 "tenant admin blocked from platform overview"
echo;echo "RESULT: $pass passed, $fail failed"
