# Build Prompt — Sage Paie v10 Payslip Distribution Software

> Standalone build prompt. Paste into a new chat with the coding agent (e.g. Opus 5.5).
> Target: Sage Paie v10 (génération i7) on Microsoft SQL Server 2019. Standalone product.

---

## ROLE
You are a senior software engineer. Build a secure "payslip distribution" application that connects to Sage Paie v10 (backed by Microsoft SQL Server 2019), extracts each employee's monthly payslip, and delivers it to the employee automatically. Context is Cameroon / OHADA payroll, so payslips contain sensitive salary data and must be handled with encryption, strict access control, and a full audit trail.

## OBJECTIVE
Given a pay period (e.g. 2026-10), the app pulls payroll data from the Sage Paie SQL Server database, produces one payslip PDF per employee, matches it to that employee's contact details, and sends it securely — then proves, via a reconciliation report, that every active employee received exactly one correct payslip.

## ENVIRONMENT (fixed)
- Payroll system: Sage Paie v10 (génération i7).
- Database: Microsoft SQL Server 2019 (connect read-only via a dedicated SQL login).
- Access the Sage data through SQL; do NOT write back to the Sage database.

## STEP 0 — SCHEMA DISCOVERY (do this first, confirm with the client)
- The exact Sage Paie v10 table/column names must be discovered, not assumed. Ask the client for: read-only SQL credentials, the database name, and permission to inspect the schema. Identify the tables holding: the employee master (matricule, names, department, email, phone, bank), the pay runs/periods, and the payslip detail (rubriques/lines, bases, amounts, employer/employee contributions, net to pay).
- Produce a short schema map document before building the extraction, and have the client validate it against 2–3 known payslips (reproduce those payslips to the franc first).

## EXTRACTION & PAYSLIP GENERATION
- For a given period, read each employee's full payslip data from SQL.
- Render a payslip PDF per employee from a template that matches the legal Cameroon/OHADA bulletin layout (employer header, employee block, earnings/deductions lines with bases and rates, CNPS/PVID, IRPP/CAC/CFC/FNE/RAV/TDL, net à payer, leave balance if available).
- Every generated payslip must tie out to the Sage figures exactly (±1 franc). Include a validation step that flags any mismatch against Sage totals.
- (Optional alternative, if the client prefers using Sage's own PDFs: watch the folder where Sage exports bulletins and split the combined PDF per employee by matricule — but the SQL route above is the primary method.)

## MATCHING
- Match each payslip to an employee by matricule (primary key), with name + department as a sanity check. Anything not confidently matched goes to an "unmatched / review" queue — never guess or send.

## DELIVERY CHANNELS (configurable per employee)
1. Email: the payslip PDF attached, each PDF password-protected with a per-employee secret (e.g. matricule + date of birth, or a one-time code communicated separately). Never email an unprotected payslip.
2. SMS / WhatsApp Business API: send a secure, expiring link to a login-gated download — not the file itself.
3. (Optional) a simple self-service web portal where an employee logs in and downloads their own payslips for past periods.
- Track delivery status per employee: PENDING, SENT, DELIVERED/OPENED, FAILED; allow re-send.

## SECURITY & COMPLIANCE (non-negotiable)
- Encrypt payslip files at rest; TLS in transit.
- Role-based access: only payroll/HR admins can run a distribution; employees access only their own payslips.
- Password-protected PDFs for email; expiring one-time links for SMS/WhatsApp.
- Full audit log: who ran what, which payslips were generated, what was sent to whom and when, and the outcome. No salary figures in logs or URLs.
- Respect OHADA / Cameroon labour-law payslip retention requirements.

## WORKFLOW
- Trigger: manual ("distribute for period YYYY-MM") and/or scheduled after each pay close.
- Pipeline: connect → extract from SQL → generate PDFs → validate vs Sage totals → match → HR review & approve (esp. unmatched/mismatched) → send → confirm → reconcile.
- Reconciliation report: list every active employee for the period and whether they got exactly one payslip; flag missing, duplicated, mismatched, or failed, each with a one-click re-send.

## ERROR HANDLING
- Idempotent per (employee, period): re-running a distribution never double-sends.
- Retries with backoff for transient email/SMS failures.
- Clear, actionable error messages; nothing fails silently.

## SUGGESTED TECH (adapt to the team's skills)
- Backend: .NET (C#) or Node.js — both have solid SQL Server 2019 drivers.
- SQL Server access: official driver (Microsoft.Data.SqlClient for .NET, or mssql/tedious for Node), read-only login.
- PDF: a templating + PDF library (e.g. QuestPDF/iText for .NET, or pdf-lib/pdfkit for Node); PDF password protection via the PDF library or qpdf.
- Delivery: SMTP for email; a WhatsApp Business / SMS provider for links.
- Storage: SQL Server or Postgres for app metadata + encrypted object/file storage for PDFs.
- Deploy: Docker; Windows or Linux host with network access to the SQL Server.

## DELIVERABLES
1. The distribution service implementing the pipeline above.
2. An admin web UI: run a distribution, view reconciliation, review unmatched/mismatched, re-send, and see the audit log.
3. The employee delivery (email + SMS/WhatsApp, and optional self-service portal).
4. A schema-map document for the client's Sage Paie v10 database.
5. Setup docs: SQL connection, PDF template config, delivery-channel config, scheduling.

## BEFORE WRITING CODE, ASK THE CLIENT
- Read-only SQL credentials + database name, and 2–3 known payslips to validate against.
- Which delivery channels, and the PDF-password / secure-link rules they want.
- The exact legal payslip layout they must reproduce (a sample official bulletin).
- Whether a self-service portal is in scope for v1 or later.

---

### Notes for whoever runs this prompt
- Sage Paie v10's SQL schema is proprietary and not publicly documented — **Step 0 (schema discovery against the real database) is make-or-break**. Don't let the agent invent table names.
- Reading the Sage database directly is robust, but confirm the Sage license/support terms allow third-party SQL read access (some Sage contracts restrict it) — check with the client's Sage reseller.
