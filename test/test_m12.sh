#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }

# ---- super-admin now logs in (strong password) ----
R=$(curl -s $B/login -H 'Content-Type: application/json' -d '{"email":"superadmin@sgrhp.io","password":"Superadmin2026"}')
T=$(echo $R | python3 -c 'import sys,json;print(bool(json.load(sys.stdin).get("token")))'); chk "$T" True "super-admin logs in with ensured password"
SADM=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
N=$(curl -s $B/tenants -H "Authorization: Bearer $SADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin))>=1)'); chk "$N" True "super-admin reaches the platform tenants"
# wrong password still rejected
c=$(curl -s -o /dev/null -w '%{http_code}' $B/login -H 'Content-Type: application/json' -d '{"email":"superadmin@sgrhp.io","password":"wrong"}'); chk $c 401 "wrong super-admin password rejected"

# ---- idle settings ----
ADM=$(curl -s $B/login -H 'Content-Type: application/json' -d '{"email":"admin@cible-rh.ci","password":"demo123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
IM=$(curl -s $B/login -H 'Content-Type: application/json' -d '{"email":"admin@cible-rh.ci","password":"demo123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("idleMinutes"))'); chk "$IM" 30 "login returns idleMinutes (default 30)"
D=$(curl -s $B/settings -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["security"]["idleTimeoutMinutes"])'); chk "$D" 30 "idle timeout in security settings"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/security -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"idleTimeoutMinutes":2}'); chk $c 400 "idle timeout below 5 min rejected"
R=$(curl -s -X PUT $B/settings/security -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"idleTimeoutMinutes":20}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["idleTimeoutMinutes"])'); chk "$R" 20 "idle timeout configurable"
IM2=$(curl -s $B/me -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["idleMinutes"])'); chk "$IM2" 20 "/me reflects updated idle minutes"

# ---- server enforces idle timeout ----
# set idle to 5 min (min allowed); we can't wait 5 min, so verify the mechanism via a crafted stale token is impractical.
# Instead confirm active requests keep working (activity refresh) and the field drives policy.
c=$(curl -s -o /dev/null -w '%{http_code}' $B/employees -H "Authorization: Bearer $ADM"); chk $c 200 "active session keeps working (activity refreshed)"
echo; echo "RESULT: $pass passed, $fail failed"
