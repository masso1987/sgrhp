#!/bin/bash
# Two-tenant data isolation: create a second company, provision its admin, and prove
# it sees ONLY its own data — none of tenant t1's (Cible RH) employees/portfolios/etc.
B=http://localhost:4000/api
pass=0;fail=0
chk(){ if [ "$1" = "$2" ];then pass=$((pass+1));echo "PASS: $3";else fail=$((fail+1));echo "FAIL: $3 (got $1 want $2)";fi; }
login(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }

SADM=$(login superadmin@sgrhp.io Superadmin2026)
T1ADM=$(login admin@cible-rh.ci demo123)
T1GPF=$(login gpf@cible-rh.ci demo123)

# t1 baseline counts
T1EMP=$(curl -s $B/employees -H "Authorization: Bearer $T1ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[ "$T1EMP" -ge 1 ] && chk 1 1 "tenant t1 sees its employees ($T1EMP)" || chk 0 1 "t1 employees"

# create tenant B WITH admin, and seed baseline
R=$(curl -s -X POST $B/tenants -H "Authorization: Bearer $SADM" -H 'Content-Type: application/json' -d '{"name":"Beta Industries","legalForm":"SARL","rccm":"RC/DLA/2026/B/55","niu":"M900000000009B","hqCity":"Yaoundé","legalRep":"Directeur Beta","email":"dg@beta.cm","adminEmail":"admin@beta.cm","adminName":"Admin Beta"}')
TP=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["admin"]["tempPassword"])')
BID=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
BADM=$(login admin@beta.cm "$TP")
[ -n "$BADM" ] && chk 1 1 "tenant B admin can log in" || chk 0 1 "B admin login"

# B sees ZERO employees (isolation from t1)
BEMP=$(curl -s $B/employees -H "Authorization: Bearer $BADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
chk "$BEMP" 0 "tenant B sees none of t1's employees"
# B sees ZERO portfolios of t1
BPF=$(curl -s $B/portfolios -H "Authorization: Bearer $BADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
chk "$BPF" 0 "tenant B sees none of t1's portfolios"

# B HAS its own baseline referentials/contract-types/conventions/salary elements (seeded)
BREF=$(curl -s $B/referentials -H "Authorization: Bearer $BADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin))>=10)')
chk "$BREF" True "tenant B has its own baseline referentials"
BCT=$(curl -s $B/config/contract-types -H "Authorization: Bearer $BADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
chk "$BCT" 2 "tenant B has its own contract types (CDI/CDD)"
BCV=$(curl -s $B/config/conventions -H "Authorization: Bearer $BADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin))>=1)')
chk "$BCV" True "tenant B has its own conventions"
BSE=$(curl -s $B/config/salary-elements -H "Authorization: Bearer $BADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin))>=5)')
chk "$BSE" True "tenant B has its own salary elements"

# B creates a portfolio + employee; verify t1 does NOT see them
BPFID=$(curl -s -X POST $B/portfolios -H "Authorization: Bearer $BADM" -H 'Content-Type: application/json' -d '{"name":"Beta Portefeuille","required":["V"]}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -o /dev/null -X POST $B/employees -H "Authorization: Bearer $BADM" -H 'Content-Type: application/json' -d "{\"firstName\":\"Beta\",\"lastName\":\"WORKER\",\"portfolioId\":\"$BPFID\",\"hireDate\":\"2026-06-01\",\"birthDate\":\"1995-01-01\",\"cniNumber\":\"CIBETA1\",\"cniExpiry\":\"2031-01-01\"}"
BEMP2=$(curl -s $B/employees -H "Authorization: Bearer $BADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
chk "$BEMP2" 1 "tenant B sees its own new employee"
# t1 still sees only its own (unchanged) count
T1EMP2=$(curl -s $B/employees -H "Authorization: Bearer $T1ADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
chk "$T1EMP2" "$T1EMP" "tenant t1 does NOT see tenant B's employee"
# same CNI can exist across tenants (uniqueness is per-tenant) — B used CIBETA1, t1 uses CI00248837; no clash
# t1 dashboard headcount unaffected
T1HC=$(curl -s $B/dashboard -H "Authorization: Bearer $T1ADM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["headcount"])')
chk "$T1HC" "$T1EMP" "t1 dashboard headcount excludes tenant B"
BHC=$(curl -s $B/dashboard -H "Authorization: Bearer $BADM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["headcount"])')
chk "$BHC" 1 "tenant B dashboard shows only its own headcount"

# B users list shows only B's users (its admin), not t1's 5
BUSERS=$(curl -s $B/users -H "Authorization: Bearer $BADM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
chk "$BUSERS" 1 "tenant B admin sees only its own users"

# reports: t1 evaluation/compliance count only t1
T1RC=$(curl -s $B/reports/compliance -H "Authorization: Bearer $T1ADM" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(all("Beta" not in i["employee"] for i in d["issues"]))')
chk "$T1RC" True "t1 compliance report excludes tenant B employees"

echo;echo "RESULT: $pass passed, $fail failed"
