#!/bin/bash
B=http://localhost:4000/api
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got $1, want $2)"; fi }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
GPF=$(tok gpf@cible-rh.ci); CD=$(tok cd@cible-rh.ci); RJ=$(tok rj@cible-rh.ci); U=$(tok ui@cible-rh.ci); ADM=$(tok admin@cible-rh.ci)
EMP=$(curl -s $B/employees -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
PF=$(curl -s $B/portfolios -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')

# --- 1. employee file export (PDF) ---
curl -s -o /tmp/dossier.pdf $B/employees/$EMP/export -H "Authorization: Bearer $CD"
head -c4 /tmp/dossier.pdf | grep -q "%PDF" && chk 1 1 "employee file exports as PDF ($(wc -c < /tmp/dossier.pdf) bytes)" || chk 0 1 "PDF export"
c=$(curl -s -o /dev/null -w '%{http_code}' $B/employees/$EMP/export -H "Authorization: Bearer $U"); chk $c 403 "UI role cannot export employee files"

# --- 2. contract types parameterizable ---
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/config/contract-types -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"name":"Interim","fixedTerm":true}'); chk $c 201 "custom contract type 'Interim' created"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"I\",\"lastName\":\"T\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CI9\",\"cniExpiry\":\"2030-01-01\",\"contract\":{\"type\":\"Interim\"}}"); chk $c 400 "Interim (fixed-term) requires end date"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"I\",\"lastName\":\"T\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CI9b\",\"cniExpiry\":\"2030-01-01\",\"contract\":{\"type\":\"Interim\",\"endDate\":\"2026-12-31\"}}"); chk $c 201 "Interim employee created with end date"
# type version trace
CTID=$(curl -s $B/config/contract-types -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print([t for t in json.load(sys.stdin) if t["name"]=="Interim"][0]["id"])')
V=$(curl -s -X PUT $B/config/contract-types/$CTID -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"name":"Intérim"}' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["versions"]))'); chk $V 2 "contract type modification versioned (v2)"

# --- 3. salary elements at employee creation ---
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"S\",\"lastName\":\"E\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CI10\",\"cniExpiry\":\"2030-01-01\",\"salary\":{\"Prime inconnue\":5000}}"); chk $c 400 "unknown salary element rejected (admin must create it)"
E2=$(curl -s -X POST $B/employees -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d "{\"firstName\":\"Sala\",\"lastName\":\"RIE\",\"portfolioId\":\"$PF\",\"hireDate\":\"2026-07-01\",\"birthDate\":\"1990-01-01\",\"cniNumber\":\"CI11\",\"cniExpiry\":\"2030-01-01\",\"contract\":{\"type\":\"CDI\",\"category\":\"B2\"},\"salary\":{\"Salaire de base\":150000,\"Indemnité de transport\":20000}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
[ -n "$E2" ] && chk 1 1 "employee created with selected salary elements" || chk 0 1 "salary employee"
# salary auto-fills template tags
TPL=$(curl -s $B/templates -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print([t for t in json.load(sys.stdin) if "CDI" in t["name"]][0]["id"])')
SB=$(curl -s $B/templates/$TPL/resolve/$E2 -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)["resolved"].get("salary_base"))'); chk "$SB" "150 000" "salary element auto-fills {{salary_base}}"
SG=$(curl -s $B/templates/$TPL/resolve/$E2 -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(json.load(sys.stdin)["resolved"].get("salary_gross"))'); chk "$SG" "170 000" "gross total computed (170 000)"

# --- 4. decision with attachment + auto-avenant ---
echo pj > /tmp/pj.pdf
D=$(curl -s -X POST $B/hr/$E2/decisions -H "Authorization: Bearer $GPF" -F type=Promotion -F detail="Promotion C1" -F newCategory=C1 -F salaryChanges='{"Salaire de base":200000}' -F file=@/tmp/pj.pdf)
AID=$(echo $D | python3 -c 'import sys,json;print(json.load(sys.stdin)["amendmentId"])')
[ "$AID" != "None" ] && chk 1 1 "promotion auto-creates salary avenant ($AID)" || chk 0 1 "auto-avenant"
FN=$(echo $D | python3 -c 'import sys,json;print(json.load(sys.stdin)["fileName"])'); chk "$FN" "pj.pdf" "decision attachment stored"
# avertissement cannot carry salary changes
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/hr/$E2/decisions -H "Authorization: Bearer $GPF" -F type=Avertissement -F salaryChanges='{"Salaire de base":1}'); chk $c 400 "salary change refused on avertissement"
# approve avenant -> salary applied
curl -s -o /dev/null -X POST $B/documents/$AID/approve -H "Authorization: Bearer $CD"
curl -s -o /dev/null -X POST $B/documents/$AID/approve -H "Authorization: Bearer $RJ"
NS=$(curl -s $B/employees/$E2 -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;e=json.load(sys.stdin);print(e["salary"]["Salaire de base"],e["contract"]["category"])'); chk "$NS" "200000 C1" "avenant applied: salary 200000, category C1"

# --- 5. fiche de poste extraction ---
F=$(curl -s -X POST $B/fiches -H "Authorization: Bearer $CD" -F title="Technicien" -F file=@/tmp/fiche_test.pdf)
N=$(echo $F | python3 -c 'import sys,json;print(json.load(sys.stdin)["sectionsFound"])')
[ "$N" -ge 4 ] && chk 1 1 "fiche de poste: $N/6 sections extracted from PDF" || chk 0 1 "extraction ($N)"
M=$(echo $F | python3 -c 'import sys,json;print("maintenance" in json.load(sys.stdin)["extracted"]["missions"])'); chk $M True "missions content extracted correctly"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/fiches -H "Authorization: Bearer $U" -F file=@/tmp/fiche_test.pdf); chk $c 403 "UI cannot upload fiches"

# --- 6. template studio ---
R=$(curl -s -X POST $B/templates/raw -H "Authorization: Bearer $ADM" -F file=@/tmp/plain.docx)
RID=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
T=$(curl -s -X POST $B/templates/raw/$RID/tagify -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"replacements":[{"find":"no tags here","tag":"employee_fullName"}],"name":"Attestation test","docType":"ATTESTATION"}')
NT=$(echo $T | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["tags"]))'); chk $NT 1 "studio converts Word doc to template (1 tag)"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/templates/raw/$RID/tagify -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"replacements":[{"find":"absent text zzz","tag":"x"}]}'); chk $c 422 "studio reports text not found"

# --- 7. salary grid ---
G=$(curl -s $B/config/salary-grid -H "Authorization: Bearer $GPF" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[ "$G" -ge 14 ] && chk 1 1 "salary grid seeded ($G categories)" || chk 0 1 "grid seeded"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/config/salary-grid -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"grid":[{"category":"B2","baseSalary":99000}]}'); chk $c 200 "GPF can edit salary grid"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/config/salary-grid -H "Authorization: Bearer $RJ" -H 'Content-Type: application/json' -d '{"grid":[{"category":"B2","baseSalary":1}]}'); chk $c 403 "RJ cannot edit grid"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/config/salary-grid -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"grid":[{"category":"ZZ","baseSalary":1000}]}'); chk $c 400 "unknown category rejected"

echo; echo "RESULT: $pass passed, $fail failed"
