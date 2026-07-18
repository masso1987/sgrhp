-- SGRHP — PostgreSQL schema (M7)
-- Every business table carries tenant_id for the multi-tenant requirement (§8.1).

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('GPF','CD','RJ','UI','ADM')),
  password TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conventions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  grid JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  convention_id TEXT REFERENCES conventions(id),
  required JSONB NOT NULL DEFAULT '["V"]'   -- CNI always present (§2.3.3)
);

CREATE TABLE IF NOT EXISTS user_portfolios (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, portfolio_id)
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  hire_date DATE NOT NULL,
  birth_date DATE NOT NULL,
  birth_place TEXT,
  marital_status TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  photo_blob TEXT,
  cni_number TEXT NOT NULL,
  cni_expiry DATE NOT NULL,
  cnps_number TEXT,
  contract JSONB NOT NULL DEFAULT '{}',
  salary JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No two employees may share a CNI or CNPS number
CREATE UNIQUE INDEX IF NOT EXISTS employees_cni_uniq  ON employees (tenant_id, cni_number);
CREATE UNIQUE INDEX IF NOT EXISTS employees_cnps_uniq ON employees (tenant_id, cnps_number)
  WHERE cnps_number IS NOT NULL AND cnps_number <> '';

CREATE TABLE IF NOT EXISTS doc_files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  blob_uri TEXT NOT NULL,          -- Azure Blob URI in production
  container TEXT,
  content_type TEXT,
  checksum TEXT,
  expiry_date DATE,                -- CNI validity, medical visits
  uploaded_by TEXT REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_files_emp ON doc_files (employee_id);
CREATE INDEX IF NOT EXISTS doc_files_expiry ON doc_files (expiry_date) WHERE expiry_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  type TEXT NOT NULL,              -- EMPLOYEE_FILE | TEMPLATE_DOC | AMENDMENT | LEAVE
  ref_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  cycle INT NOT NULL DEFAULT 1,
  version INT,
  template_id TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  generated_file TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  generated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS documents_ref ON documents (ref_id);
CREATE INDEX IF NOT EXISTS documents_status ON documents (status);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('CD','RJ')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  warned_at TIMESTAMPTZ,           -- 36h alert
  breached_at TIMESTAMPTZ,         -- 48h breach, imputed to the validator
  decided_at TIMESTAMPTZ,
  decision TEXT CHECK (decision IN ('APPROVED','REJECTED')),
  validator_id TEXT REFERENCES users(id),
  elapsed_h INT,
  reject_reason TEXT,
  -- §4.2: a rejection must always carry a reason
  CONSTRAINT reject_needs_reason CHECK (decision <> 'REJECTED' OR (reject_reason IS NOT NULL AND reject_reason <> ''))
);
CREATE INDEX IF NOT EXISTS wf_open ON workflow_steps (document_id) WHERE decided_at IS NULL;

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT,
  date DATE NOT NULL,
  file_name TEXT,
  blob_uri TEXT,
  amendment_id TEXT REFERENCES documents(id),
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referentials (
  key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  label TEXT NOT NULL,
  tag TEXT,
  system BOOLEAN NOT NULL DEFAULT false,
  values JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS contract_types (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  fixed_term BOOLEAN NOT NULL DEFAULT false,
  system BOOLEAN NOT NULL DEFAULT false,
  versions JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS salary_elements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  tag TEXT
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  doc_type TEXT,
  blob_uri TEXT NOT NULL,
  original_name TEXT,
  tags JSONB NOT NULL DEFAULT '[]',
  uploaded_by TEXT REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fiches_poste (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  file_name TEXT,
  blob_uri TEXT,
  extracted JSONB NOT NULL DEFAULT '{}',
  sections_found INT,
  uploaded_by TEXT REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Career & performance (§6)
CREATE TABLE IF NOT EXISTS career_paths (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL, stages JSONB NOT NULL DEFAULT '[]');

CREATE TABLE IF NOT EXISTS career_plans (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  preferred_positions JSONB DEFAULT '[]', preferred_locations JSONB DEFAULT '[]',
  availability TEXT, potential INT CHECK (potential BETWEEN 1 AND 9),
  career_path_id TEXT REFERENCES career_paths(id), trainings JSONB DEFAULT '[]',
  updated_by TEXT REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS okrs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period TEXT NOT NULL, objective TEXT NOT NULL, key_results JSONB NOT NULL DEFAULT '[]',
  created_by TEXT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS evaluations_360 (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name TEXT, criteria JSONB NOT NULL DEFAULT '[]', evaluators JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_by TEXT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date DATE NOT NULL, notes TEXT, next_date DATE,
  manager_id TEXT REFERENCES users(id), manager_name TEXT);

CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL, date DATE NOT NULL, summary TEXT,
  signatures JSONB NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'DRAFT',
  created_by TEXT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS succession_plans (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_position TEXT NOT NULL, criticality TEXT NOT NULL,
  risk_of_departure TEXT, successors JSONB NOT NULL DEFAULT '[]',
  created_by TEXT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'IN_APP', subject TEXT NOT NULL, body TEXT, ref TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(), read_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS notif_user ON notifications (user_id, read_at);

-- Append-only audit trail (§4.1)
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT, user_name TEXT, role TEXT,
  action TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT,
  detail JSONB, ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_user ON audit_log (tenant_id, user_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_object ON audit_log (object_type, object_id);
CREATE INDEX IF NOT EXISTS audit_action ON audit_log (action, at DESC);

-- Audit rows must never be updated or deleted
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_no_change ON audit_log;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
