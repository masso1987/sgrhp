#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }
GPF=$(tok gpf@cible-rh.ci); CD=$(tok cd@cible-rh.ci); UI=$(tok ui@cible-rh.ci); ADM=$(tok admin@cible-rh.ci)

# ---- export ----
curl -s -o /tmp/emp.xlsx "$B/data/export?format=xlsx" -H "Authorization: Bearer $CD"
python3 -c "import openpyxl,sys;wb=openpyxl.load_workbook('/tmp/emp.xlsx');print('SHEETS',wb.sheetnames)" 2>/dev/null | grep -q "Employés" && chk 1 1 "Excel export has an Employés sheet" || chk 0 1 "xlsx export"
python3 -c "import openpyxl;wb=openpyxl.load_workbook('/tmp/emp.xlsx');ws=wb['Employés'];print(ws.max_column)" > /tmp/cols 2>/dev/null; C=$(cat /tmp/cols); [ "${C:-0}" -ge 20 ] && chk 1 1 "export includes many fields ($C columns)" || chk 0 1 "many fields ($C)"
curl -s -o /tmp/emp.pdf "$B/data/export?format=pdf" -H "Authorization: Bearer $ADM"; head -c4 /tmp/emp.pdf | grep -q "%PDF" && chk 1 1 "PDF export produced" || chk 0 1 "pdf export"
c=$(curl -s -o /dev/null -w '%{http_code}' "$B/data/export?format=xlsx" -H "Authorization: Bearer $UI"); chk $c 403 "UI role cannot export"

# ---- import template ----
curl -s -o /tmp/tpl.xlsx "$B/data/import/template" -H "Authorization: Bearer $GPF"; head -c2 /tmp/tpl.xlsx | grep -q "PK" && chk 1 1 "import template downloadable" || chk 0 1 "template"

# ---- build an import file with python (2 good rows, 1 dup CNI, 1 bad category) ----
PF=$(curl -s $B/portfolios -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["name"])')
python3 - "$PF" <<'PY'
import openpyxl, sys
pf=sys.argv[1]
wb=openpyxl.Workbook(); ws=wb.active
ws.append(["Nom","Prenoms","Portefeuille","Embauche","Naissance","CNI","Validite CNI","Type contrat","Categorie"])
ws.append(["NGUEMA","Paul",pf,"2026-01-05","1990-05-05","IMP001","2031-01-01","CDI","B2"])
ws.append(["ABENA","Marie",pf,"2026-02-05","1992-06-06","IMP002","2031-01-01","CDD","C1"])   # CDD no end date -> error
ws.append(["DUP","Licate",pf,"2026-03-05","1993-07-07","CI00248837","2031-01-01","CDI","B2"]) # dup CNI (seeded)
ws.append(["BADCAT","X",pf,"2026-04-05","1994-08-08","IMP004","2031-01-01","CDI","ZZ9"])       # bad category
wb.save("/tmp/import.xlsx")
PY
# analyze
R=$(curl -s -X POST $B/data/import/analyze -H "Authorization: Bearer $GPF" -F file=@/tmp/import.xlsx)
TOKEN=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
RC=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["rowCount"])'); chk $RC 4 "analyze detects 4 rows"
AM=$(echo $R | python3 -c 'import sys,json;m=json.load(sys.stdin)["suggestedMapping"];print("lastName" in m and "portfolio" in m)'); chk $AM True "columns auto-mapped (Nom, Portefeuille)"

# full mapping
MAP='{"lastName":"Nom","firstName":"Prenoms","portfolio":"Portefeuille","hireDate":"Embauche","birthDate":"Naissance","cniNumber":"CNI","cniExpiry":"Validite CNI","contractType":"Type contrat","category":"Categorie"}'
# required field missing -> 400
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/data/import/validate -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"mapping\":{\"lastName\":\"Nom\"}}"); chk $c 400 "validate rejects incomplete mapping"
# validate dry-run
V=$(curl -s -X POST $B/data/import/validate -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"mapping\":$MAP}")
echo "$V" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("valid",d["valid"],"invalid",d["invalid"])'
VAL=$(echo "$V" | python3 -c 'import sys,json;print(json.load(sys.stdin)["valid"])'); chk $VAL 1 "dry-run: 1 valid row"
INV=$(echo "$V" | python3 -c 'import sys,json;print(json.load(sys.stdin)["invalid"])'); chk $INV 3 "dry-run: 3 invalid (CDD no end, dup CNI, bad category)"
# nothing imported yet
N0=$(curl -s $B/employees -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
# commit
C=$(curl -s -X POST $B/data/import/commit -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"mapping\":$MAP}")
IMP=$(echo $C | python3 -c 'import sys,json;print(json.load(sys.stdin)["imported"])'); chk $IMP 1 "commit imports the valid row only"
SK=$(echo $C | python3 -c 'import sys,json;print(json.load(sys.stdin)["skipped"])'); chk $SK 3 "commit skips the 3 invalid rows"
N1=$(curl -s $B/employees -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); chk $((N1-N0)) 1 "employee count increased by 1"
# imported employee is real and valid
FOUND=$(curl -s $B/employees -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(any(e["cniNumber"]=="IMP001" and e["contract"]["category"]=="B2" for e in json.load(sys.stdin)))'); chk $FOUND True "imported employee has correct CNI + category"
# audit + expired token
N=$(curl -s "$B/audit?action=IMPORTED" -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'); [ "$N" -ge 1 ] && chk 1 1 "import audited" || chk 0 1 "import audited"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/data/import/commit -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"mapping\":$MAP}"); chk $c 400 "consumed import token no longer usable"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/data/import/analyze -H "Authorization: Bearer $UI" -F file=@/tmp/import.xlsx); chk $c 403 "UI role cannot import"

echo; echo "RESULT: $pass passed, $fail failed"
