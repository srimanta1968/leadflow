-- Migration 013: the AI foundation — activity ledger, budgets, agent runs,
-- capability tokens and the human-review gate.
--
-- WHAT MIGRATION 012 BUILT AND WHAT THIS BUILDS. 012 shipped two AI modules
-- (SDR and Sales Coach) each with its own proposal table, and each enforcing the
-- review requirement in its own handler. That works for two modules and stops
-- working at three: the guarantee "no consequential AI output reaches a customer
-- without human acceptance" would live in as many places as there are modules,
-- and the third one to be written is the one that forgets. This migration moves
-- the guarantee into a single gate every module goes through, and adds the four
-- controls every completion must be able to show for itself.

-- ---------------------------------------------------------------------------
-- The AI activity ledger.
-- ---------------------------------------------------------------------------
--
-- ONE ROW PER COMPLETION ATTEMPT, INCLUDING THE REFUSALS. A ledger holding only
-- successes cannot answer the question actually asked after an incident — "did
-- we generate anything for this person after they objected" — because a refusal
-- and never-having-been-asked look identical in it.
--
-- IT HOLDS NO PROMPT AND NO OUTPUT TEXT. Deliberate, and the reason is not
-- storage: the output belongs on the proposal, where a human reviews it and
-- where an erasure can redact it. Copying it here would create a second, quieter
-- copy of the same personal data on a surface nobody thinks of as one — and the
-- ledger's job is to record that a completion happened under stated controls,
-- which needs the CONTROLS, not the content.
CREATE TABLE IF NOT EXISTS ai_completion (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              VARCHAR(255) NOT NULL,
  agent_key              VARCHAR(64)  NOT NULL,
  run_id                 UUID,
  -- WHICH VERSION of the approved prompt produced this. A complaint about
  -- wording arrives months later, by which time the library has moved on; the
  -- version is what makes "what did it actually say" answerable.
  prompt_template_key    VARCHAR(64)  NOT NULL,
  prompt_template_version VARCHAR(32) NOT NULL,
  purpose                VARCHAR(64)  NOT NULL,

  -- CONTROL 1 — consent. The receipt reference this completion was permitted
  -- under, never the consent record itself.
  consent_basis_ref      VARCHAR(255),
  consent_method         VARCHAR(32),

  -- CONTROL 2 — budget. The reservation this completion was charged against.
  budget_reservation_ref VARCHAR(255),
  tokens_charged         INTEGER      NOT NULL DEFAULT 0,

  -- CONTROL 3 — redaction. WHICH RULES FIRED AND HOW MANY SPANS EACH REMOVED,
  -- never the removed values. A ledger that stored what it redacted would be the
  -- one place in the system holding the personal data everything else took out.
  redaction_applied      JSONB,
  redacted_span_count    INTEGER      NOT NULL DEFAULT 0,

  -- CONTROL 4 — trace. Minted BEFORE anything else happens, which is why it is
  -- the one control that is NOT NULL on every row: a refusal has a trace too,
  -- and without one the refusal cannot be correlated with the request that
  -- provoked it.
  trace_id               VARCHAR(64)  NOT NULL,
  upstream_completion_id VARCHAR(255),

  outcome                VARCHAR(24)  NOT NULL,
  -- Why it was refused, in the vocabulary the caller was given. Null on success.
  refusal_reason         VARCHAR(64),
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT ai_completion_outcome_ck CHECK (outcome IN (
    'completed', 'refused_halted', 'refused_consent', 'refused_budget',
    'refused_template', 'upstream_error'
  )),

  -- AC2 ENFORCED BY THE SCHEMA, not only by the code path above it. A row
  -- claiming a completion happened must be able to name the consent it was
  -- permitted under, the budget it was charged to, and the redaction that ran.
  -- Put another way: a completion that cannot show its four controls cannot be
  -- INSERTED, so a future caller who bypasses the service layer gets a
  -- constraint violation rather than an unaccountable completion.
  CONSTRAINT ai_completion_controls_ck CHECK (
    outcome <> 'completed'
    OR (consent_basis_ref IS NOT NULL
        AND budget_reservation_ref IS NOT NULL
        AND redaction_applied IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_completion_tenant_idx
  ON ai_completion (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_completion_run_idx
  ON ai_completion (run_id) WHERE run_id IS NOT NULL;
-- The incident query: what did we refuse, and why. Partial, because refusals are
-- the minority and an index over every row would be paid for on every insert to
-- answer a question only asked about a few.
CREATE INDEX IF NOT EXISTS ai_completion_refusal_idx
  ON ai_completion (created_at DESC) WHERE outcome <> 'completed';

-- ---------------------------------------------------------------------------
-- Per-tenant AI budget.
-- ---------------------------------------------------------------------------
--
-- APP-SCOPED, NOT CUSTOMER-SCOPED. A budget shared across a customer's apps
-- means one app's runaway loop silently halts the others, and the operator of
-- the halted app has no visibility into who spent their allowance.
--
-- PERIODS ARE ROWS, NOT A RESET. A monthly reset that overwrites the counter
-- destroys the only record of what last month cost, which is exactly the number
-- someone asks for when the bill arrives.
CREATE TABLE IF NOT EXISTS ai_budget (
  tenant_id     VARCHAR(255) NOT NULL,
  -- First day of the budget period this row counts.
  period_start  DATE         NOT NULL,
  token_limit   INTEGER      NOT NULL,
  tokens_spent  INTEGER      NOT NULL DEFAULT 0,
  -- Set the moment the limit is first hit, and never cleared within the period.
  -- Kept as a timestamp rather than a boolean because "when did we run out" is
  -- the question that follows "why did generation stop".
  exhausted_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, period_start),
  CONSTRAINT ai_budget_limit_ck CHECK (token_limit >= 0),
  CONSTRAINT ai_budget_spent_ck CHECK (tokens_spent >= 0)
);

-- ---------------------------------------------------------------------------
-- Agent runs.
-- ---------------------------------------------------------------------------
--
-- A LOCAL RECORD OF AN UPSTREAM RUN, and that duplication is the point. The kill
-- switch must be able to halt every run immediately; asking sdk-agent-runtime
-- "what is currently running" during the incident in which the switch was pulled
-- assumes the very service that may be misbehaving is reachable and honest. This
-- table lets LeadFlow halt what it started using only its own database.
CREATE TABLE IF NOT EXISTS ai_agent_run (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key       VARCHAR(64)  NOT NULL,
  upstream_run_id VARCHAR(255),
  status          VARCHAR(16)  NOT NULL DEFAULT 'running',
  trace_id        VARCHAR(64)  NOT NULL,
  started_by      VARCHAR(255),
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at        TIMESTAMPTZ,
  halted_reason   VARCHAR(128),
  CONSTRAINT ai_agent_run_status_ck
    CHECK (status IN ('running', 'completed', 'halted', 'failed'))
);

-- The halt query, and the only one that matters under time pressure.
CREATE INDEX IF NOT EXISTS ai_agent_run_active_idx
  ON ai_agent_run (started_at DESC) WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- Capability tokens.
-- ---------------------------------------------------------------------------
--
-- THE SECRET IS NOT HERE. Only the upstream token id, the capabilities it was
-- minted with, and its lifecycle. A capability token stored at rest is a
-- standing grant somebody can lift out of a backup; what this table is for is
-- answering "what was this agent allowed to touch, and is that grant still
-- live" — which needs the scope, not the credential.
CREATE TABLE IF NOT EXISTS ai_capability_token (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID         NOT NULL REFERENCES ai_agent_run (id) ON DELETE CASCADE,
  agent_key         VARCHAR(64)  NOT NULL,
  upstream_token_id VARCHAR(255),
  -- The EXACT capability list this token carries. Stored so a later question
  -- about an agent's reach is answered from what was actually minted rather than
  -- from what the registry says today — the registry can be edited, the issued
  -- token cannot.
  capabilities      JSONB        NOT NULL,
  issued_at         TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at        TIMESTAMPTZ  NOT NULL,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    VARCHAR(128)
);

CREATE INDEX IF NOT EXISTS ai_capability_token_run_idx
  ON ai_capability_token (run_id);

-- ---------------------------------------------------------------------------
-- The human-review gate.
-- ---------------------------------------------------------------------------
--
-- ONE TABLE FOR EVERY CONSEQUENTIAL OUTPUT KIND, which is the difference between
-- this and ai_sdr_proposal in migration 012. That table is the SDR module's own,
-- shaped around a drafted first touch; this one holds whatever an agent
-- proposes — a message, a score, a summary, a next action, a change of offer
-- terms — so a module added next year inherits the gate instead of
-- re-implementing it.
--
-- THERE IS NO 'delivered' STATE AND NO DELIVERY COLUMN, for the same reason 012
-- has no `sent`: a status a machine could set is a status a machine will
-- eventually set. Acceptance is the terminal state this table knows about.
CREATE TABLE IF NOT EXISTS ai_proposal (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                VARCHAR(24)  NOT NULL,
  agent_key           VARCHAR(64)  NOT NULL,
  -- The completion that produced it, so a proposal can always be traced back to
  -- the consent, budget, redaction and trace it was generated under.
  completion_id       UUID REFERENCES ai_completion (id),
  subject_type        VARCHAR(64),
  subject_id          UUID,
  -- What the agent proposes. JSONB rather than TEXT because the shape differs
  -- per kind and flattening a score into prose would make it unreviewable.
  content             JSONB        NOT NULL,
  -- The reviewer's edit, kept ALONGSIDE the original — the same call migration
  -- 012 made for drafts, and for the same reason: the original is the only
  -- evidence of what the machine actually produced.
  edited_content      JSONB,
  status              VARCHAR(16)  NOT NULL DEFAULT 'proposed',
  -- WHICH AUTHORITY A REVIEWER NEEDED, stamped at proposal time rather than
  -- looked up at decision time. "Qualified human" is the whole requirement, and
  -- resolving the permission when the decision is made would let a later edit to
  -- the role matrix retroactively change who was qualified to approve something
  -- already approved.
  required_permission VARCHAR(64)  NOT NULL,
  decision_note       TEXT,
  decided_by_user_id  UUID,
  decided_at          TIMESTAMPTZ,
  -- The PDP verdict that permitted the decision, joining the acceptance to the
  -- authorisation that allowed it.
  decision_ref        VARCHAR(64),
  proposed_at         TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT ai_proposal_status_ck
    CHECK (status IN ('proposed', 'accepted', 'rejected')),
  -- Exactly the four SOP §21 names: "AI may suggest messages, scores,
  -- summaries, and next actions". Closed for that reason and not for tidiness —
  -- a fifth value would be a category of machine output the SOP has not
  -- sanctioned, and widening this CHECK is the moment to notice that.
  CONSTRAINT ai_proposal_kind_ck
    CHECK (kind IN ('message', 'score', 'summary', 'next_action')),
  -- A decided proposal must name who decided it. Without this the table can hold
  -- an acceptance with no accepter, which is precisely the record AC1 exists to
  -- make impossible.
  CONSTRAINT ai_proposal_decided_ck CHECK (
    status = 'proposed'
    OR (decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);

-- The reviewer's queue: what is waiting on a human, oldest first.
CREATE INDEX IF NOT EXISTS ai_proposal_awaiting_idx
  ON ai_proposal (proposed_at) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS ai_proposal_subject_idx
  ON ai_proposal (subject_type, subject_id);

COMMENT ON TABLE ai_completion IS
  'The AI activity ledger. One row per completion ATTEMPT including refusals, carrying the four controls (consent, budget, redaction, trace) and no prompt or output text.';
COMMENT ON CONSTRAINT ai_completion_controls_ck ON ai_completion IS
  'A completion that cannot name its consent basis, budget reservation and redaction result cannot be inserted.';
COMMENT ON TABLE ai_agent_run IS
  'Local record of every agent run LeadFlow started, so the kill switch can halt them from this database alone rather than by asking the runtime that may be the thing misbehaving.';
COMMENT ON TABLE ai_capability_token IS
  'Capability tokens issued per run. Holds the SCOPE and the lifecycle, never the credential.';
COMMENT ON TABLE ai_proposal IS
  'The human-review gate for every consequential AI output. No delivered state and no delivery column: acceptance is the terminal state, and delivery is a separate human act.';
COMMENT ON COLUMN ai_proposal.required_permission IS
  'Stamped at proposal time so a later edit to the role matrix cannot retroactively change who was qualified to approve an already-approved output.';
