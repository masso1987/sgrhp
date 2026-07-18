#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }
ADM=$(tok admin@cible-rh.ci); GPF=$(tok gpf@cible-rh.ci)

# health endpoint
S=$(curl -s http://localhost:4000/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["status"],d["storage"])'); chk "$S" "ok json" "health endpoint reports status + backend"
# security headers
H=$(curl -sI http://localhost:4000/ | grep -ci "x-frame-options\|x-content-type-options"); [ "$H" -ge 1 ] && chk 1 1 "security headers present (helmet)" || chk 0 1 "security headers"
P=$(curl -sI http://localhost:4000/ | grep -ci "x-powered-by"); chk $P 0 "x-powered-by hidden"

# password policy on user creation
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/users -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"fullName":"Weak","email":"weak@x.ci","role":"GPF","password":"abc"}'); chk $c 400 "weak password rejected (too short)"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/users -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"fullName":"NoUpper","email":"nu@x.ci","role":"GPF","password":"abcdefghij1"}'); chk $c 400 "password without uppercase rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/users -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"fullName":"Strong","email":"strong@x.ci","role":"GPF","password":"Motdepasse2026"}'); chk $c 201 "strong password accepted"

# self-service password change
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/me/password -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"current":"wrong","next":"Motdepasse2026"}'); chk $c 401 "password change requires the current password"

# brute force lockout
for i in 1 2 3 4 5; do curl -s -o /dev/null $B/login -H 'Content-Type: application/json' -d '{"email":"cd@cible-rh.ci","password":"bad"}'; done
c=$(curl -s -o /dev/null -w '%{http_code}' $B/login -H 'Content-Type: application/json' -d '{"email":"cd@cible-rh.ci","password":"demo123"}'); chk $c 423 "account locked after 5 failed attempts"
N=$(curl -s "$B/audit?action=LOCKED" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 1 ] && chk 1 1 "lockout recorded in audit trail" || chk 0 1 "lockout audited"
N=$(curl -s "$B/audit?action=LOGIN" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 2 ] && chk 1 1 "successful logins audited ($N)" || chk 0 1 "logins audited"

# 2FA enrolment
Q=$(curl -s -X POST $B/2fa/setup -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["qr"].startswith("data:image/png") and len(d["manualKey"])>10)'); chk "$Q" True "2FA setup returns QR code + manual key"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/2fa/confirm -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"totp":"000000"}'); chk $c 400 "wrong 2FA code rejected at enrolment"
T=$(curl -s $B/me -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print("twoFactor" in json.load(sys.stdin))'); chk $T True "/me exposes 2FA status without leaking the secret"
S=$(curl -s $B/me -H "Authorization: Bearer $ADM" | grep -c "totpSecret"); chk $S 0 "TOTP secret never returned to the client"

# expired/invalid token
c=$(curl -s -o /dev/null -w '%{http_code}' $B/employees -H "Authorization: Bearer invalid.token.here"); chk $c 401 "invalid token rejected"

echo; echo "RESULT: $pass passed, $fail failed"
