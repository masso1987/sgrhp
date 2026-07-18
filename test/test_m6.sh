#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); CD=$(tok cd@cible-rh.ci); U=$(tok ui@cible-rh.ci); ADM=$(tok admin@cible-rh.ci)

N=$(curl -s $B/reports -H "Authorization: Bearer $CD" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); chk $N 5 "5 reports available"
c=$(curl -s -o /dev/null -w '%{http_code}' $B/reports/kpis -H "Authorization: Bearer $U"); chk $c 403 "UI cannot read reports"
c=$(curl -s -o /dev/null -w '%{http_code}' $B/reports/unknown -H "Authorization: Bearer $ADM"); chk $c 404 "unknown report -> 404"

K=$(curl -s $B/reports/kpis -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d["headcount"]>0 and "payroll" in d and "buckets" in d and "byPortfolio" in d)'); chk $K True "KPI report: headcount, payroll, age pyramid, portfolios"
E=$(curl -s $B/reports/evaluation -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(any(r["role"]=="GPF" for r in d) and any(r["role"] in ("CD","RJ") for r in d))'); chk $E True "evaluation report covers GPF + validators"
R=$(curl -s $B/reports/evaluation -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];g=[r for r in d if r["role"]=="GPF"][0];print("rejectionRate" in g and "topRejectReason" in g)'); chk $R True "rejection rate + recurring reason computed"
C=$(curl -s $B/reports/compliance -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(0<=d["score"]<=100 and isinstance(d["issues"],list))'); chk $C True "CNPS compliance report with score"
S=$(curl -s $B/reports/sla -H "Authorization: Bearer $CD" | python3 -c 'import sys,json;print(isinstance(json.load(sys.stdin)["data"],list))'); chk $S True "SLA report returns rows"

# exports
curl -s -o /tmp/r.pdf "$B/reports/kpis/export?format=pdf" -H "Authorization: Bearer $ADM"
head -c4 /tmp/r.pdf | grep -q "%PDF" && chk 1 1 "KPI report exports as PDF ($(wc -c < /tmp/r.pdf) bytes)" || chk 0 1 "PDF export"
curl -s -o /tmp/r.xlsx "$B/reports/compliance/export?format=xlsx" -H "Authorization: Bearer $ADM"
python3 -c "
import zipfile;z=zipfile.ZipFile('/tmp/r.xlsx');assert 'xl/workbook.xml' in z.namelist();print('ok')" >/dev/null 2>&1 && chk 1 1 "compliance report exports as Excel" || chk 0 1 "xlsx export"
c=$(curl -s -o /dev/null -w '%{http_code}' "$B/reports/kpis/export?format=doc" -H "Authorization: Bearer $ADM"); chk $c 400 "invalid export format rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' "$B/reports/kpis/export?format=pdf" -H "Authorization: Bearer $GPF"); chk $c 403 "GPF cannot export reports"
N=$(curl -s "$B/audit?action=EXPORTED" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 2 ] && chk 1 1 "exports audited ($N)" || chk 0 1 "exports audited"

echo; echo "RESULT: $pass passed, $fail failed"
