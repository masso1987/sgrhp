# SGRHP — Milestones 1+2 — WORKING APP

## M1 (Foundation)
Login + JWT auth, 5 roles with server-side RBAC, employee files with per-portfolio
document checklists (CNI locked as universally mandatory), file uploads, audit log.

## M2 (Validation workflow)
Two-level validation: GPF submits (blocked until required docs complete) -> CD validates (48h SLA)
-> RJ validates (48h SLA) -> official document generated automatically -> Print User downloads/prints (logged).
Mandatory rejection reasons, resubmission cycles counted, SLA timers (36h warning, 48h breach,
business hours), in-app notifications (bell icon).

## Run
```bash
npm start          # http://localhost:4000  (dependencies included)
```
Sign in (password `demo123`): gpf@ / cd@ / rj@ / ui@ / admin@ cible-rh.ci

## Try the full workflow
1. As **gpf@**: open the seeded employee, upload the missing documents, click "Submit for validation"
2. As **cd@**: Validation Queue -> Validate (or Reject — reason required)
3. As **rj@**: Validation Queue -> Validate -> document generated
4. As **ui@**: Generated Docs -> Download / Print (both logged in the audit trail)
5. As **admin@**: Audit Log shows every step

## Tests
`bash test/test_m1.sh` (17 checks) · `bash test/test_m2.sh` (17 checks) · `node test/test_sla.js` (SLA timers)

## M3 (Template-based generation + admin settings)
- Word templates with {{placeholders}} (CDD & CDI CRHE contracts pre-loaded); Admin > Templates to upload more
- Generation form: auto-fill from employee file (green) + required missing info (amber), with dropdowns
  fed by admin-managed referentials (conventions collectives, categories, postes, villes...)
- Admin creates portfolios (CNI always included) and links several portfolios per GPF (Users screen)
- Final Word contract rendered automatically on RJ approval

## M4 (Contracts, decisions, leave)
- Contract amendments (avenants) with versioning: CD->RJ workflow, applied to the live contract
  only after final approval; full history kept
- Decisions & sanctions (types from admin referential), audited
- Leave/permissions/final settlement: balance tracking (1.5 d/month), requests through the
  validation workflow, balance deducted on approval
- Generation formatting: French dates, thousands separators, mission table auto-filled

## M5 (Career & Performance)
- Career plans: preferences, availability, potential matrix (1-9), career paths, trainings
- Predictive matching: internal mobility suggestions scored on preferences + potential + OKR results
- OKR: objectives/key results with live progress bars
- 360 evaluations: custom criteria, evaluators (manager/peer/subordinate/self), consolidation
- Check-ins + digital interviews with e-signature (identity + timestamp, audited, archived)
- Succession plans: key positions, criticality, successor readiness (now / 1-2y / to develop)

## M6 (Analytics & Reports)
- Real-time KPIs: headcount, payroll mass, turnover, absenteeism, age pyramid,
  breakdown by portfolio / contract type / convention category
- User evaluation indicators from the logs: submissions, rejection rate, recurring
  rejection reasons, resubmissions, average validation delay, 48h breaches per validator
- CNPS & labour-law compliance report with a 0-100 score and ranked anomalies
- SLA report per document and stage
- Every report exportable to PDF and Excel (exports audited)

## M7 (Production hardening)
- PostgreSQL storage adapter + full relational schema (db/schema.sql), migration script
- 2FA TOTP (QR enrolment) enforced for administrators, password policy, account lockout,
  login rate limiting, helmet security headers, /health endpoint
- Interface entirely in French
- Docker + docker-compose (app + PostgreSQL), GitHub Actions CI running 159 checks
- Backup/restore scripts, DEPLOYMENT.md (including Azure guidance)

## Reste à faire
Voir DEPLOYMENT.md § « Reste à faire avant la mise en production ».
