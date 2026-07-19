#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }
ADM=$(tok admin@cible-rh.ci); GPF=$(tok gpf@cible-rh.ci)

# settings visibility
S=$(curl -s $B/settings -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("security" in d and "email" in d)'); chk $S True "settings readable by admin"
c=$(curl -s -o /dev/null -w '%{http_code}' $B/settings -H "Authorization: Bearer $GPF"); chk $c 403 "non-admin cannot read settings"

# security policy
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/security -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"sessionHours":99}'); chk $c 400 "invalid session duration rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/security -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"maxFailedLogins":1}'); chk $c 400 "invalid lockout threshold rejected"
R=$(curl -s -X PUT $B/settings/security -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"require2faForAdmins":false,"sessionHours":12,"maxFailedLogins":6}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["sessionHours"],d["maxFailedLogins"])'); chk "$R" "12 6" "security policy saved"

# 2FA policy actually drives login
curl -s -o /dev/null -X PUT $B/settings/security -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"require2faForAdmins":true}'
c=$(curl -s -o /dev/null -w '%{http_code}' $B/login -H 'Content-Type: application/json' -d '{"email":"admin@cible-rh.ci","password":"demo123"}'); chk $c 428 "2FA required -> enrolment prompted (428)"
# enrol from the login screen with email+password
Q=$(curl -s -X POST $B/2fa/setup -H 'Content-Type: application/json' -d '{"email":"admin@cible-rh.ci","password":"demo123"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["qr"].startswith("data:image/png"))'); chk "$Q" True "QR code served for pre-login enrolment"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/2fa/setup -H 'Content-Type: application/json' -d '{"email":"admin@cible-rh.ci","password":"wrong"}'); chk $c 401 "enrolment refuses a bad password"
# confirm with a real TOTP code, then log in with it
KEY=$(curl -s -X POST $B/2fa/setup -H 'Content-Type: application/json' -d '{"email":"admin@cible-rh.ci","password":"demo123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["manualKey"])')
CODE=$(node -e "console.log(require('speakeasy').totp({secret:'$KEY',encoding:'base32'}))")
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/2fa/confirm -H 'Content-Type: application/json' -d "{\"email\":\"admin@cible-rh.ci\",\"password\":\"demo123\",\"totp\":\"$CODE\"}"); chk $c 200 "2FA enrolment confirmed with a valid code"
c=$(curl -s -o /dev/null -w '%{http_code}' $B/login -H 'Content-Type: application/json' -d '{"email":"admin@cible-rh.ci","password":"demo123"}'); chk $c 401 "login now demands the 2FA code"
CODE=$(node -e "console.log(require('speakeasy').totp({secret:'$KEY',encoding:'base32'}))")
T=$(curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"admin@cible-rh.ci\",\"password\":\"demo123\",\"totp\":\"$CODE\"}" | python3 -c 'import sys,json;print(bool(json.load(sys.stdin).get("token")))'); chk "$T" True "login succeeds with a valid 2FA code"
ADM=$(curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"admin@cible-rh.ci\",\"password\":\"demo123\",\"totp\":\"$CODE\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/me/2fa/disable -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{}'); chk $c 403 "cannot disable 2FA while the policy requires it"

# masked password must not overwrite the stored secret
N=$(curl -s "$B/audit?action=CONFIG_CHANGED" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin))>=3)'); chk $N True "settings changes are audited"

echo; echo "RESULT: $pass passed, $fail failed"
