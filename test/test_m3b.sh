#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); ADM=$(tok admin@cible-rh.ci); CD=$(tok cd@cible-rh.ci)

# 1. ADM creates portfolio -> CNI auto-included
R=$(curl -s -X POST $B/portfolios -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"name":"ENEO Missions","required":["I","IX"]}')
NPF=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
HASCNI=$(echo $R | python3 -c 'import sys,json;print("V" in json.load(sys.stdin)["required"])'); chk $HASCNI True "new portfolio auto-includes CNI"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/portfolios -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"name":"X"}'); chk $c 403 "GPF cannot create portfolios"

# 2. link portfolios to GPF (several)
GID=$(curl -s $B/users -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print([u for u in json.load(sys.stdin) if u["role"]=="GPF"][0]["id"])')
PFS=$(curl -s $B/portfolios -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(json.dumps([p["id"] for p in json.load(sys.stdin)]))')
N=$(curl -s -X PUT $B/users/$GID/portfolios -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d "{\"portfolioIds\":$PFS}" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["portfolioIds"]))')
[ "$N" -ge 4 ] && chk 1 1 "GPF linked to $N portfolios (multi-portfolio OK)" || chk 0 1 "multi-portfolio link"
# non-GPF user rejected
CDID=$(curl -s $B/users -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print([u for u in json.load(sys.stdin) if u["role"]=="CD"][0]["id"])')
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/users/$CDID/portfolios -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"portfolioIds":[]}'); chk $c 400 "assignment restricted to GPF users"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/users/$GID/portfolios -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"portfolioIds":[]}'); chk $c 403 "non-ADM cannot link portfolios"

# 3. GPF can now create employee in the new portfolio
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"New\",\"lastName\":\"PF\",\"portfolioId\":\"$NPF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CI1\",\"cniExpiry\":\"2030-01-01\"}"); chk $c 201 "GPF works in newly linked portfolio"

# 4. referentials seeded, incl. conventions collectives linked to tag
R=$(curl -s $B/referentials -H "Authorization: Bearer $GPF")
N=$(echo $R | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 7 ] && chk 1 1 "referentials seeded ($N lists)" || chk 0 1 "referentials seeded"
T=$(echo $R | python3 -c 'import sys,json;print([r["tag"] for r in json.load(sys.stdin) if r["key"]=="collectiveAgreements"][0])'); chk $T collective_agreement "conventions collectives linked to {{collective_agreement}}"

# 5. ADM adds a convention; CD cannot modify
V=$(echo $R | python3 -c 'import sys,json;print(json.dumps([r["values"] for r in json.load(sys.stdin) if r["key"]=="collectiveAgreements"][0]+["Convention ENEO 2026"]))')
N=$(curl -s -X PUT $B/referentials/collectiveAgreements -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d "{\"values\":$V}" | python3 -c 'import sys,json;print("Convention ENEO 2026" in json.load(sys.stdin)["values"])'); chk $N True "ADM adds a convention collective"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/referentials/collectiveAgreements -H "Authorization: Bearer $CD" -H 'Content-Type: application/json' -d '{"values":["x"]}'); chk $c 403 "CD cannot edit referentials"

# 6. ADM creates custom referential linked to a tag
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/referentials -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"key":"transportAllowances","label":"Indemnités transport","tag":"allowance_transport"}'); chk $c 201 "custom referential created with tag link"
# system referential cannot be deleted
c=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $B/referentials/categories -H "Authorization: Bearer $ADM"); chk $c 400 "system referential protected"
# config changes audited
N=$(curl -s "$B/audit?action=CONFIG_CHANGED" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 4 ] && chk 1 1 "all config changes audited ($N entries)" || chk 0 1 "config audited"

echo; echo "RESULT: $pass passed, $fail failed"
