-- AI Revenue Recovery — schema
-- SQLite. Every table is append-friendly so the audit trail is never overwritten.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Who owes us money
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  segment           TEXT NOT NULL CHECK (segment IN ('consumer','prosumer','smb','enterprise')),
  phone             TEXT NOT NULL,
  email             TEXT NOT NULL,
  -- 0..1 historical on-time payment behaviour. Feeds the outcome simulator and
  -- the "customer value" axis of the intervention matrix.
  reliability_score REAL NOT NULL,
  lifetime_value_inr INTEGER NOT NULL,
  timezone          TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  -- Day of month income typically lands. Used to time insufficient_funds retries.
  salary_day        INTEGER,
  preferred_channel TEXT NOT NULL CHECK (preferred_channel IN ('sms','whatsapp','email')),
  -- Hard stops. Once set, the agent may never contact or retry this customer again.
  opted_out_at      TEXT,
  disputed_at       TEXT,
  created_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- What they owe it on
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  plan_name       TEXT NOT NULL,
  amount_inr      INTEGER NOT NULL,
  frequency       TEXT NOT NULL CHECK (frequency IN ('monthly','quarterly','annual')),
  status          TEXT NOT NULL CHECK (status IN ('pending','active','past_due','paused','cancelled')),
  mandate_type    TEXT NOT NULL CHECK (mandate_type IN ('upi_autopay','card','enach')),
  started_at      TEXT NOT NULL,
  next_billing_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  invoice_number TEXT NOT NULL,
  amount_inr     INTEGER NOT NULL,
  issued_at      TEXT NOT NULL,
  due_at         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('open','overdue','paid','written_off')),
  po_number      TEXT
);

-- ---------------------------------------------------------------------------
-- The failure event that puts revenue at risk
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_attempts (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  subscription_id TEXT REFERENCES subscriptions(id),
  invoice_id      TEXT REFERENCES invoices(id),
  amount_inr      INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('failed','succeeded','pending')),
  decline_code    TEXT,
  gateway_message TEXT,
  -- Attempts the gateway already made on its own before recovery took over.
  attempt_number  INTEGER NOT NULL DEFAULT 1,
  channel         TEXT NOT NULL CHECK (channel IN ('autopay','checkout','invoice_link')),
  created_at      TEXT NOT NULL,
  CHECK (subscription_id IS NOT NULL OR invoice_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- The agent's unit of work
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_cases (
  id                    TEXT PRIMARY KEY,
  payment_attempt_id    TEXT NOT NULL REFERENCES payment_attempts(id),
  customer_id           TEXT NOT NULL REFERENCES customers(id),
  case_type             TEXT NOT NULL CHECK (case_type IN ('subscription','checkout','b2b_invoice')),
  root_cause            TEXT,
  root_cause_confidence REAL,
  amount_at_risk_inr    INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('open','in_progress','awaiting_response','recovered','promise_to_pay','failed','stopped')),
  attempts_used         INTEGER NOT NULL DEFAULT 0,
  opened_at             TEXT NOT NULL,
  closed_at             TEXT,
  closure_reason        TEXT,
  recovered_amount_inr  INTEGER NOT NULL DEFAULT 0,
  -- When the agent should next look at this case: the moment the open response
  -- window expires, the moment a scheduled action comes due, or a promised
  -- payment date. NULL on a closed case. This column is what makes the case
  -- resumable -- the scheduler finds work by asking for rows whose time has come
  -- rather than by re-deriving state.
  next_action_at        TEXT,
  -- The intervention the case is currently waiting on a response to.
  awaiting_log_id       TEXT REFERENCES intervention_logs(id),
  -- 'simulated' -> outcomes come from the probability tables in outcomes.js.
  -- 'live'      -> a real message went to a real phone and the only thing that
  --                can close this case is a real payment event.
  delivery_mode         TEXT NOT NULL DEFAULT 'simulated'
                        CHECK (delivery_mode IN ('simulated','live'))
);

-- ---------------------------------------------------------------------------
-- Everything the agent did, and why
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intervention_logs (
  id             TEXT PRIMARY KEY,
  case_id        TEXT NOT NULL REFERENCES recovery_cases(id),
  sequence       INTEGER NOT NULL,
  action_type    TEXT NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('none','sms','whatsapp','email','voice')),
  tone           TEXT,
  message_sent   TEXT,
  scheduled_for  TEXT,
  executed_at    TEXT,
  -- Set when the message goes out; the case sits in 'awaiting_response' until
  -- this passes or a payment arrives. NULL on a silent retry, which has no
  -- window -- there is nobody to respond and the gateway answers immediately.
  response_deadline_at TEXT,
  -- When the response actually landed, whichever way it went.
  responded_at   TEXT,
  outcome        TEXT CHECK (outcome IN ('recovered','failed','no_response','promise_to_pay','suppressed')),
  outcome_detail TEXT
);

CREATE TABLE IF NOT EXISTS promises_to_pay (
  id                 TEXT PRIMARY KEY,
  case_id            TEXT NOT NULL REFERENCES recovery_cases(id),
  promised_date      TEXT NOT NULL,
  promised_amount_inr INTEGER NOT NULL,
  captured_via       TEXT,
  fulfilled          INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);

-- Plain-English audit trail. One row per decision the engine makes.
CREATE TABLE IF NOT EXISTS audit_entries (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES recovery_cases(id),
  sequence        INTEGER NOT NULL,
  event_type      TEXT NOT NULL,
  decision        TEXT NOT NULL,
  reasoning_text  TEXT NOT NULL,
  -- 'llm' when Claude wrote the reasoning, 'template' on deterministic fallback.
  reasoning_source TEXT NOT NULL DEFAULT 'template',
  policy_refs     TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS engine_runs (
  id               TEXT PRIMARY KEY,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  cases_processed  INTEGER NOT NULL DEFAULT 0,
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_attempts_customer   ON payment_attempts(customer_id);
CREATE INDEX IF NOT EXISTS idx_cases_status        ON recovery_cases(status);
-- The scheduler's only query: which cases are due for another look.
CREATE INDEX IF NOT EXISTS idx_cases_next_action  ON recovery_cases(next_action_at)
  WHERE next_action_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cases_customer      ON recovery_cases(customer_id);
CREATE INDEX IF NOT EXISTS idx_interventions_case  ON intervention_logs(case_id, sequence);
CREATE INDEX IF NOT EXISTS idx_audit_case          ON audit_entries(case_id, sequence);
