#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }
ADM=$(tok admin@cible-rh.ci); GPF=$(tok gpf@cible-rh.ci)

# public branding (no auth) so login screen can theme itself
c=$(curl -s -o /tmp/br.json -w '%{http_code}' $B/branding); chk $c 200 "branding readable without auth"
D=$(python3 -c 'import json;d=json.load(open("/tmp/br.json"));print("appName" in d and "colors" in d and "sectionColors" in d)'); chk $D True "branding has appName, colors, sectionColors"

# admin updates theme
R=$(curl -s -X PUT $B/settings/branding -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"appName":"MonRH","colors":{"primary":"#004080","accent":"#ff6600"},"sectionColors":{"career":"#8800cc"},"density":"compact"}')
N=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["appName"])'); chk "$N" "MonRH" "app name saved"
P=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["colors"]["primary"])'); chk "$P" "#004080" "primary colour saved"
S=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["sectionColors"]["career"])'); chk "$S" "#8800cc" "per-section colour saved"
DN=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["density"])'); chk "$DN" "compact" "density saved"
# reflected on the public endpoint
P2=$(curl -s $B/branding | python3 -c 'import sys,json;print(json.load(sys.stdin)["colors"]["primary"])'); chk "$P2" "#004080" "theme reflected on public endpoint"

# validation
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/branding -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"colors":{"primary":"red"}}'); chk $c 400 "invalid colour rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/branding -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"logo":"notanimage"}'); chk $c 400 "invalid logo rejected"
V=$(curl -s -X PUT $B/settings/branding -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"logo":"data:image/png;base64,iVBORw0KGgo="}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["logo"].startswith("data:image/png"))'); chk "$V" True "valid data-URL logo accepted"

# access control + audit
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/branding -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"appName":"X"}'); chk $c 403 "non-admin cannot change branding"
N=$(curl -s "$B/audit?objectType=Settings" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(sum(1 for x in json.load(sys.stdin) if x["objectId"]=="branding")>=1)'); chk $N True "branding changes audited"

echo; echo "RESULT: $pass passed, $fail failed"
