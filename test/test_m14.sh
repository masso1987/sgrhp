#!/bin/bash
B=http://localhost:4000/api
pass=0;fail=0
chk(){ if [ "$1" = "$2" ];then pass=$((pass+1));echo "PASS: $3";else fail=$((fail+1));echo "FAIL: $3 (got $1 want $2)";fi; }
tok(){ curl -s $B/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }
ADM=$(tok admin@cible-rh.ci); GPF=$(tok gpf@cible-rh.ci)

# email config present with providers + templates + recipients
S=$(curl -s $B/settings -H "Authorization: Bearer $ADM")
E=$(echo "$S" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("email" in d and "emailTemplates" in d and "emailRecipients" in d)'); chk "$E" True "email, templates, recipients in settings"
P=$(echo "$S" | python3 -c 'import sys,json;print(json.load(sys.stdin)["email"]["provider"])'); chk "$P" smtp "default provider smtp"
T=$(echo "$S" | python3 -c 'import sys,json;print("rejected" in json.load(sys.stdin)["emailTemplates"])'); chk "$T" True "notification templates seeded (rejected)"

# provider validation
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/email -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"provider":"orange"}'); chk $c 400 "unknown provider rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/email -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"enabled":true,"provider":"smtp","smtp":{"host":""}}'); chk $c 400 "enabling SMTP without host rejected"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/email -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"enabled":true,"provider":"postmark","postmark":{"serverToken":""}}'); chk $c 400 "Postmark requires token"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/email -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"enabled":true,"provider":"mailgun","mailgun":{"domain":"","smtpLogin":""}}'); chk $c 400 "Mailgun requires domain+login"

# configure SES provider
R=$(curl -s -X PUT $B/settings/email -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"enabled":true,"provider":"ses","from":"RH <rh@cible.cm>","ses":{"region":"eu-west-1","smtpUser":"AKIAX","smtpPass":"secret"}}')
PV=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["provider"])'); chk "$PV" ses "SES provider saved"
# secret masked on read
M=$(curl -s $B/settings -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["email"]["ses"]["smtpPass"])'); chk "$M" "********" "SES secret masked"
# masked value doesn't overwrite
curl -s -o /dev/null -X PUT $B/settings/email -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"ses":{"smtpPass":"********","region":"us-east-1"}}'
RG=$(curl -s $B/settings -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["email"]["ses"]["region"])'); chk "$RG" us-east-1 "masked secret preserved on partial update"

# templates: edit FR + EN
R=$(curl -s -X PUT $B/settings/email/templates -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"rejected":{"subjectFr":"Rejeté : {{title}}","subjectEn":"Rejected: {{title}}","bodyFr":"Motif {{reason}}","bodyEn":"Reason {{reason}}"}}')
SF=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["rejected"]["subjectEn"])'); chk "$SF" "Rejected: {{title}}" "template EN subject saved"

# recipients: extra + validation
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/email/recipients -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"globalCC":"not-an-email"}'); chk $c 400 "invalid recipient rejected"
R=$(curl -s -X PUT $B/settings/email/recipients -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"globalCC":"dg@cible.cm, audit@cible.cm","byEvent":{"slaBreach":"superviseur@cible.cm"}}')
CC=$(echo "$R" | python3 -c 'import sys,json;print("dg@cible.cm" in json.load(sys.stdin)["globalCC"])'); chk "$CC" True "global CC recipients saved"
EV=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["byEvent"]["slaBreach"])'); chk "$EV" "superviseur@cible.cm" "per-event recipient saved"

# test email: invalid address + unreachable provider
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/settings/email/test -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"to":"bad"}'); chk $c 400 "test rejects invalid address"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/settings/email/test -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"to":"someone@example.com"}'); chk $c 400 "test reports unreachable provider as failure"

# access control
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings/email -H "Authorization: Bearer $GPF" -H 'Content-Type: application/json' -d '{"enabled":false}'); chk $c 403 "non-admin cannot change email config"
echo;echo "RESULT: $pass passed, $fail failed"
