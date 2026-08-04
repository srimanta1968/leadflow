import { randomUUID } from 'crypto';
import {
  AI_AGENTS,
  AI_CAPABILITIES,
  KIND_REQUIRES_PERMISSION,
  agentByKey,
  allProposalKinds,
} from '../../src/config/aiAgents';
import { PROMPT_TEMPLATES, promptTemplateVersion } from '../../src/config/promptTemplates';
import { allGrantedPermissions } from '../../src/config/roles';
import { dataService } from '../../src/services/DataService';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';
import { complete } from '../../src/platform/ai/aiGateway';
import {
  activeRuns,
  endRun,
  haltAllRuns,
  mintCapabilityToken,
  startRun,
} from '../../src/platform/ai/agentRuntime';
import { currentBudget, reserveTokens, setPeriodLimit } from '../../src/platform/ai/aiBudget';
import { completionById } from '../../src/platform/ai/activityLedger';
import { killSwitchState, resetKillSwitchCache } from '../../src/platform/ai/killSwitch';
import { renderTemplate, resolveTemplate } from '../../src/platform/ai/promptLibrary';
import { redact, redactSlots } from '../../src/platform/ai/redaction';
import { decide, propose, proposalById } from '../../src/platform/ai/reviewGate';
import { AppError } from '../../src/utils/errors';

/**
 * The AI foundation: the review gate, the four controls on every completion,
 * capability scoping, and the kill switch.
 *
 * INTEGRATION, because the guarantees are enforced against real rows and real
 * constraints. Three of the four acceptance criteria here are claims about what
 * the system REFUSES to do, and a refusal asserted against a mock is a claim
 * about the mock. AC2 in particular is enforced by a CHECK constraint, which
 * only a real database can be asked about.
 *
 * The suite runs with no gateway configured (see tests/setup.ts), which is the
 * state that exercises the local halt path, the local ledger and the pinned
 * prompt library — all of which have to work when upstream does not.
 */

const REVIEWER = randomUUID();

/** Roles the SOP gives a rep. Holds message.send_approved and stage.update. */
const REP_ROLES = ['sales_rep'];
/** Roles the SOP gives a manager. Holds call.review and NOT message.send_approved. */
const MANAGER_ROLES = ['sales_manager'];

beforeAll(async () => {
  resetKillSwitchCache();
  delete process.env.AI_KILL_SWITCH;
});

afterEach(async () => {
  delete process.env.AI_KILL_SWITCH;
  delete process.env.AI_CONSENT_LOCAL_ONLY;
  resetKillSwitchCache();
  // Runs left behind would be halted by another test's kill-switch assertion and
  // make its count wrong.
  await dataService.query(
    "UPDATE ai_agent_run SET status = 'completed', ended_at = CURRENT_TIMESTAMP WHERE status = 'running'",
    []
  );
});

// ---------------------------------------------------------------------------
// AC1 — no consequential AI output reaches a customer without human acceptance
// ---------------------------------------------------------------------------

describe('the human-review gate (AC1)', () => {
  it('records a proposal that is inert until a human decides it', async () => {
    const proposal = await propose({
      agentKey: 'sdr_first_touch',
      kind: 'message',
      content: { body: 'Thanks for reaching out — I will call you shortly.' },
    });

    expect(proposal.status).toBe('proposed');
    // Structurally incapable of being true, and present so this assertion can
    // exist at all.
    expect(proposal.delivered).toBe(false);
    expect(proposal.decidedByUserId).toBeNull();
  });

  it('offers no way to mark a proposal delivered, because the column does not exist', async () => {
    const columns = await dataService.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_proposal'`,
      []
    );
    const names = columns.map((row) => row.column_name);

    // The guarantee is the ABSENCE of the mechanism, not a guard on it. A status
    // a machine could set is a status a machine will eventually set.
    expect(names).not.toContain('delivered');
    expect(names).not.toContain('delivered_at');
    expect(names).not.toContain('sent_at');
  });

  it('refuses a reviewer who does not hold the authority the kind demands', async () => {
    const proposal = await propose({
      agentKey: 'sdr_first_touch',
      kind: 'message',
      content: { body: 'A draft only a rep may release.' },
    });

    // A Sales Manager may review calls and may NOT release messages — exactly as
    // when a human writes one by hand. If this ever passes, accepting a
    // machine's suggestion has become a way round the permission matrix.
    await expect(
      decide({
        proposalId: proposal.id,
        decision: 'accept',
        roles: MANAGER_ROLES,
        userId: REVIEWER,
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    const after = await proposalById(proposal.id);
    expect(after?.status).toBe('proposed');
  });

  it('accepts from a reviewer who does hold it, and records who', async () => {
    const proposal = await propose({
      agentKey: 'sdr_first_touch',
      kind: 'message',
      content: { body: 'A draft a rep may release.' },
    });

    const result = await decide({
      proposalId: proposal.id,
      decision: 'accept',
      roles: REP_ROLES,
      userId: REVIEWER,
    });

    expect(result.proposal.status).toBe('accepted');
    expect(result.proposal.decidedByUserId).toBe(REVIEWER);
    expect(result.requiredPermission).toBe('message.send_approved');
    // The PDP verdict is joined to the acceptance, so "what permitted this" is
    // answerable from the row.
    expect(result.decisionRef).toMatch(/^pdp_/);
  });

  it('keeps a reviewer edit ALONGSIDE the original, never over it', async () => {
    const original = { body: 'The draft the machine produced.' };
    const proposal = await propose({
      agentKey: 'sdr_first_touch',
      kind: 'message',
      content: original,
    });

    const result = await decide({
      proposalId: proposal.id,
      decision: 'accept',
      roles: REP_ROLES,
      userId: REVIEWER,
      editedContent: { body: 'What the rep actually sent.' },
    });

    // The original is the only evidence of what the machine produced, and it is
    // exactly the record needed to tell whether the drafts are improving.
    expect(result.proposal.content).toEqual(original);
    expect(result.proposal.editedContent).toEqual({ body: 'What the rep actually sent.' });
    expect(result.wasEdited).toBe(true);
  });

  it('records a rejection rather than deleting it', async () => {
    const proposal = await propose({
      agentKey: 'sales_coach',
      kind: 'summary',
      content: { text: 'A summary a manager did not agree with.' },
    });

    await decide({
      proposalId: proposal.id,
      decision: 'reject',
      roles: MANAGER_ROLES,
      userId: REVIEWER,
      note: 'Mischaracterises the objection.',
    });

    // "How often does a human turn the machine down" is the most useful number
    // about an AI feature, and a deleted row cannot answer it.
    const after = await proposalById(proposal.id);
    expect(after?.status).toBe('rejected');
    expect(after?.decisionNote).toBe('Mischaracterises the objection.');
  });

  it('treats a second decision as a conflict, not a silent no-op', async () => {
    const proposal = await propose({
      agentKey: 'next_action_planner',
      kind: 'next_action',
      content: { action: 'Call back Thursday' },
    });

    await decide({
      proposalId: proposal.id,
      decision: 'accept',
      roles: REP_ROLES,
      userId: REVIEWER,
    });

    // Two acceptances mean two people each believed they were the one taking
    // responsibility for this output.
    await expect(
      decide({ proposalId: proposal.id, decision: 'accept', roles: REP_ROLES, userId: REVIEWER })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('bounds what each agent may propose by the registry', async () => {
    // Otherwise any agent reaches any authority just by naming a different kind.
    await expect(
      propose({
        agentKey: 'next_action_planner',
        kind: 'message',
        content: { body: 'Let me send this myself.' },
      })
    ).rejects.toBeInstanceOf(AppError);
  });

  it('refuses output citing a completion the ledger does not hold', async () => {
    await expect(
      propose({
        agentKey: 'sales_coach',
        kind: 'summary',
        content: { text: 'Produced by something unaccounted for.' },
        completionId: '00000000-0000-0000-0000-000000000000',
      })
    ).rejects.toMatchObject({ code: 'AI_COMPLETION_NOT_ACCOUNTED' });
  });

  it('stamps the required permission at proposal time, not at decision time', async () => {
    const proposal = await propose({
      agentKey: 'sales_coach',
      kind: 'score',
      content: { score: 71 },
    });

    // Stored, so a later edit to the kind map cannot retroactively change who
    // was qualified to approve something already approved.
    expect(proposal.requiredPermission).toBe(KIND_REQUIRES_PERMISSION.score);
  });

  it('names only permissions the role matrix actually defines', () => {
    // A kind mapped to a permission no role holds would be a proposal nobody
    // could ever decide — an output stuck in the queue forever, which reads as a
    // bug in the gate rather than as the deliberate refusal it would be.
    const granted = new Set(allGrantedPermissions());
    for (const kind of allProposalKinds()) {
      expect(granted.has(KIND_REQUIRES_PERMISSION[kind])).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — every completion carries consent, budget, redaction and trace records
// ---------------------------------------------------------------------------

describe('the four controls on every completion (AC2)', () => {
  it('cannot insert a completion that fails to name its controls', async () => {
    // The criterion enforced by the SCHEMA, not only by the code path above it:
    // a future caller who bypasses the service layer gets a constraint violation
    // rather than an unaccountable completion.
    await expect(
      dataService.query(
        `INSERT INTO ai_completion
           (tenant_id, agent_key, prompt_template_key, prompt_template_version, purpose,
            trace_id, outcome)
         VALUES ('t', 'sdr_first_touch', 'sdr_first_touch', 'v1', 'lead_management',
                 'tr_test', 'completed')`,
        []
      )
    ).rejects.toThrow(/ai_completion_controls_ck/);
  });

  it('accepts a REFUSAL with no consent or budget, because a refusal is not a completion', async () => {
    const traceId = `tr_${randomUUID()}`;
    await dataService.query(
      `INSERT INTO ai_completion
         (tenant_id, agent_key, prompt_template_key, prompt_template_version, purpose,
          trace_id, outcome, refusal_reason)
       VALUES ('t', 'sdr_first_touch', 'sdr_first_touch', 'v1', 'lead_management',
               $1, 'refused_consent', 'no_consent_basis_supplied')`,
      [traceId]
    );

    const row = await dataService.queryOne<{ trace_id: string }>(
      'SELECT trace_id FROM ai_completion WHERE trace_id = $1',
      [traceId]
    );
    // A refusal has a trace too. Without one it cannot be correlated with the
    // request that provoked it, and refusals are what an incident review reads.
    expect(row?.trace_id).toBe(traceId);
  });

  it('writes a ledger row for a completion refused on consent, and refuses it', async () => {
    const before = await ledgerCount();

    await expect(
      complete({
        agentKey: 'sdr_first_touch',
        slots: { first_name: 'Dana', reference: 'the spring campaign', channel: 'email' },
        // lead_management is not a consent-registry purpose, so no receipt means
        // no basis — an agent acting on a person's data must name one.
        consentBasisRef: null,
      })
    ).rejects.toMatchObject({ code: 'AI_CONSENT_BASIS_MISSING' });

    // The refusal is a RECORD, not a log line: an absent entry cannot
    // distinguish "we declined" from "nobody asked", and only the first is
    // evidence the gate works.
    expect(await ledgerCount()).toBe(before + 1);
    const latest = await latestCompletion();
    expect(latest?.outcome).toBe('refused_consent');
    expect(latest?.traceId).toMatch(/^tr_/);
  });

  it('redacts contact points out of the slot values before they leave', () => {
    const result = redact('Reach Dana on dana.okafor@example.test or +44 7700 900123 today.');

    expect(result.text).not.toMatch(/dana\.okafor@example\.test/);
    expect(result.text).not.toMatch(/7700/);
    // A typed placeholder rather than a deletion: the sentence stays
    // grammatical, so nobody "fixes" the odd-looking output by removing the
    // redaction.
    expect(result.text).toContain('{{email}}');
    expect(result.text).toContain('{{phone}}');
    expect(result.applied.map((hit) => hit.rule).sort()).toEqual(['email', 'phone']);
  });

  it('does not carry regex state between two redacted strings', () => {
    // The /g flag on a shared RegExp keeps lastIndex, so the second string would
    // be scanned from wherever the first stopped and an address would survive.
    const first = redact('a@b.test');
    const second = redact('c@d.test');

    expect(first.spanCount).toBe(1);
    expect(second.spanCount).toBe(1);
  });

  it('reports which rules fired, not merely that redaction ran', () => {
    const result = redactSlots({
      note: 'card 4111 1111 1111 1111 and token sk_live_abcdefghij',
      subject: 'Follow up',
    });

    const rules = result.applied.map((hit) => hit.rule).sort();
    expect(rules).toEqual(['bearer_token', 'payment_card']);
    // A boolean "redaction ran" cannot distinguish a clean prompt from
    // misconfigured rules that matched nothing.
    expect(result.spanCount).toBe(2);
    expect(result.slots.subject).toBe('Follow up');
  });

  it('reserves budget before the call and refuses when the period is spent', async () => {
    const before = await currentBudget();
    await setPeriodLimit(before.tokensSpent + 100);

    const reservation = await reserveTokens(60);
    expect(reservation.reservedTokens).toBe(60);

    // The conditional UPDATE is what makes this safe: two callers cannot both be
    // told there is room for the last tokens.
    await expect(reserveTokens(60)).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });

    await setPeriodLimit(before.tokenLimit);
  });

  it('marks the period exhausted when the limit is first reached', async () => {
    const before = await currentBudget();
    await setPeriodLimit(before.tokensSpent + 10);
    await reserveTokens(10);

    const after = await currentBudget();
    expect(after.exhaustedAt).not.toBeNull();
    expect(after.remainingTokens).toBe(0);

    // Raising the limit clears the mark, because the tenant is no longer
    // exhausted.
    const raised = await setPeriodLimit(before.tokenLimit);
    expect(raised.exhaustedAt).toBeNull();
  });

  it('returns the reservation when nothing was generated', async () => {
    const before = await currentBudget();

    // No gateway in this suite, so the completion cannot happen. Charging for it
    // would make the budget report spend that never occurred.
    await expect(
      complete({
        agentKey: 'sdr_first_touch',
        slots: { first_name: 'Dana', reference: 'the spring campaign', channel: 'email' },
        consentBasisRef: 'rcpt_test',
      })
    ).rejects.toBeInstanceOf(AppError);

    const after = await currentBudget();
    expect(after.tokensSpent).toBe(before.tokensSpent);
  });
});

// ---------------------------------------------------------------------------
// AC3 — capability tokens scope each agent to the minimum necessary access
// ---------------------------------------------------------------------------

describe('capability scoping (AC3)', () => {
  it('mints a token carrying exactly the agent registry capabilities', async () => {
    const run = await startRun({ agentKey: 'sales_coach' });
    const token = await mintCapabilityToken({ runId: run.id, agentKey: 'sales_coach' });

    expect(token.capabilities.sort()).toEqual([...agentByKey('sales_coach')!.capabilities].sort());
    // The secret is returned to the caller and NOT stored: a capability token at
    // rest is a standing grant somebody can lift out of a backup.
    const stored = await dataService.queryOne<{ capabilities: string[] }>(
      'SELECT capabilities FROM ai_capability_token WHERE id = $1',
      [token.id]
    );
    expect(stored?.capabilities.sort()).toEqual(token.capabilities.sort());

    await endRun(run.id, 'completed');
  });

  it('refuses a capability the agent is not registered with', async () => {
    const run = await startRun({ agentKey: 'next_action_planner' });

    // The registry is the ceiling. A call site asking for more gets an error
    // rather than a wider token — widening reach must be an edit to
    // config/aiAgents.ts, which is reviewable.
    await expect(
      mintCapabilityToken({
        runId: run.id,
        agentKey: 'next_action_planner',
        requested: [AI_CAPABILITIES.LEAD_READ, AI_CAPABILITIES.CONVERSATION_DRAFT],
      })
    ).rejects.toMatchObject({ code: 'AI_CAPABILITY_NOT_DECLARED' });

    await endRun(run.id, 'completed');
  });

  it('allows a run to take FEWER capabilities than its agent holds', async () => {
    const run = await startRun({ agentKey: 'sdr_first_touch' });
    const token = await mintCapabilityToken({
      runId: run.id,
      agentKey: 'sdr_first_touch',
      requested: [AI_CAPABILITIES.LEAD_READ],
    });

    // A run that only reads should not carry the draft capability its agent is
    // allowed. Narrowing is the point; only widening is refused.
    expect(token.capabilities).toEqual([AI_CAPABILITIES.LEAD_READ]);

    await endRun(run.id, 'completed');
  });

  it('expires every token rather than issuing a standing grant', async () => {
    const run = await startRun({ agentKey: 'sales_coach' });
    const token = await mintCapabilityToken({ runId: run.id, agentKey: 'sales_coach' });

    // Per RUN, never per agent: a grant that outlives the work it was for is a
    // grant whoever holds a copy keeps.
    expect(new Date(token.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(token.runId).toBe(run.id);

    await endRun(run.id, 'completed');
  });

  it('revokes a run\'s tokens when the run ends', async () => {
    const run = await startRun({ agentKey: 'sales_coach' });
    const token = await mintCapabilityToken({ runId: run.id, agentKey: 'sales_coach' });

    await endRun(run.id, 'completed');

    const row = await dataService.queryOne<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM ai_capability_token WHERE id = $1',
      [token.id]
    );
    expect(row?.revoked_at).not.toBeNull();
  });

  it('keeps every registered agent list short enough to review', () => {
    // "Minimum necessary" stays true by being short enough to read. An agent
    // listing six capabilities to do one job is a review finding.
    for (const agent of AI_AGENTS) {
      expect(agent.capabilities.length).toBeGreaterThan(0);
      expect(agent.capabilities.length).toBeLessThanOrEqual(4);
      expect(new Set(agent.capabilities).size).toBe(agent.capabilities.length);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — global kill switch halts all agent runs immediately
// ---------------------------------------------------------------------------

describe('the global kill switch (AC4)', () => {
  it('halts every running agent and revokes their live tokens', async () => {
    const first = await startRun({ agentKey: 'sales_coach' });
    const second = await startRun({ agentKey: 'next_action_planner' });
    const token = await mintCapabilityToken({ runId: first.id, agentKey: 'sales_coach' });

    const summary = await haltAllRuns('model produced unapproved copy');

    expect(summary.runsHalted).toBeGreaterThanOrEqual(2);
    expect(await activeRuns()).toHaveLength(0);

    // REVOKING THE TOKENS is what makes it immediate. Marking rows halted stops
    // nothing: a run holding a live capability token keeps acting until
    // something refuses it.
    const revoked = await dataService.queryOne<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM ai_capability_token WHERE id = $1',
      [token.id]
    );
    expect(revoked?.revoked_at).not.toBeNull();

    const rows = await dataService.query<{ status: string; halted_reason: string }>(
      'SELECT status, halted_reason FROM ai_agent_run WHERE id = ANY($1)',
      [[first.id, second.id]]
    );
    expect(rows.every((row) => row.status === 'halted')).toBe(true);
    expect(rows[0].halted_reason).toBe('model produced unapproved copy');
  });

  it('halts using this database alone, with no gateway reachable', async () => {
    // The moment the switch is pulled is the moment you least want to depend on
    // the availability of the service being halted. The suite runs with no
    // gateway, so this test passing IS that guarantee.
    expect(SdkGatewayClient.isConfigured()).toBe(false);

    const run = await startRun({ agentKey: 'sales_coach' });
    const summary = await haltAllRuns('local halt with no upstream');

    expect(summary.runsHalted).toBeGreaterThanOrEqual(1);
    expect(summary.propagated).toBe(false);
    const row = await dataService.queryOne<{ status: string }>(
      'SELECT status FROM ai_agent_run WHERE id = $1',
      [run.id]
    );
    expect(row?.status).toBe('halted');
  });

  it('refuses to start a new run while engaged', async () => {
    process.env.AI_KILL_SWITCH = 'engaged';
    resetKillSwitchCache();

    // Checked at run start as well as inside `complete`: a run that started
    // while halted would sit in the table looking live, and an operator watching
    // the queue drain would see it grow.
    await expect(startRun({ agentKey: 'sales_coach' })).rejects.toMatchObject({
      code: 'AI_HALTED',
      statusCode: 503,
    });
  });

  it('refuses a completion while engaged, and records the refusal', async () => {
    process.env.AI_KILL_SWITCH = 'engaged';
    resetKillSwitchCache();
    const before = await ledgerCount();

    await expect(
      complete({
        agentKey: 'sdr_first_touch',
        slots: { first_name: 'Dana', reference: 'the spring campaign', channel: 'email' },
        consentBasisRef: 'rcpt_test',
      })
    ).rejects.toMatchObject({ code: 'AI_HALTED' });

    expect(await ledgerCount()).toBe(before + 1);
    const latest = await latestCompletion();
    expect(latest?.outcome).toBe('refused_halted');
  });

  it('costs nothing to refuse: no consent check and no budget spend', async () => {
    process.env.AI_KILL_SWITCH = 'engaged';
    resetKillSwitchCache();
    const budgetBefore = await currentBudget();

    await expect(
      complete({
        agentKey: 'sdr_first_touch',
        slots: { first_name: 'Dana', reference: 'the spring campaign', channel: 'email' },
        consentBasisRef: 'rcpt_test',
      })
    ).rejects.toMatchObject({ code: 'AI_HALTED' });

    // The switch is checked FIRST. A halted system should not spend a consent
    // check or a token deciding not to run.
    const budgetAfter = await currentBudget();
    expect(budgetAfter.tokensSpent).toBe(budgetBefore.tokensSpent);
    const latest = await latestCompletion();
    expect(latest?.consentBasisRef).toBeNull();
    expect(latest?.budgetReservationRef).toBeNull();
  });

  it('lets the local override win over anything the flag service would say', async () => {
    process.env.AI_KILL_SWITCH = 'engaged';
    resetKillSwitchCache();

    const state = await killSwitchState();
    // An operator who has set it has made a deliberate statement about THIS
    // process, and a flag service must not quietly overrule them.
    expect(state.engaged).toBe(true);
    expect(state.source).toBe('local_env');
  });

  it('is not engaged by default on a deployment with no flag service', async () => {
    resetKillSwitchCache();
    const state = await killSwitchState();

    // You cannot fail closed against a switch nobody installed. This is the
    // opposite of the consent gate, and the difference is whether the
    // restriction exists independently of our ability to check it.
    expect(state.engaged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The versioned prompt library
// ---------------------------------------------------------------------------

describe('the versioned prompt library', () => {
  it('refuses a template that is not in the library', async () => {
    // There is no path for free prompt text: a caller who can pass raw text is a
    // caller who can send unapproved copy.
    await expect(resolveTemplate('anything_i_fancy')).rejects.toMatchObject({
      code: 'PROMPT_TEMPLATE_NOT_PERMITTED',
    });
  });

  it('falls back to the pinned version when the taxonomy is unreachable', async () => {
    const template = await resolveTemplate('sdr_first_touch');

    // Safe HERE, unlike the kill switch, because the pinned template is not an
    // assumption about an unknown state — it is approved copy that shipped in
    // this build.
    expect(template.source).toBe('pinned');
    expect(template.version).toBe('sop-v3.0-email1');
  });

  it('is the single source of the SDR module\'s template version', () => {
    // It was a literal in sdrQualifyService until the library existed. A second
    // copy of a version string is a second thing to forget on the day somebody
    // publishes new copy.
    expect(promptTemplateVersion('sdr_first_touch')).toBe('sop-v3.0-email1');
  });

  it('refuses an undeclared slot and a missing one', async () => {
    const template = await resolveTemplate('sdr_first_touch');

    // The first is how prose sneaks into approved copy; the second leaves a
    // literal {first_name} in a message a rep might accept without reading.
    expect(() =>
      renderTemplate(template, {
        first_name: 'Dana',
        reference: 'the campaign',
        channel: 'email',
        postscript: 'and we can offer 20% off',
      })
    ).toThrow(/not declared/);

    expect(() => renderTemplate(template, { first_name: 'Dana' })).toThrow(/not supplied/);
  });

  it('does not interpret a slot value as a replacement pattern', async () => {
    const template = await resolveTemplate('sdr_first_touch');

    // `$&` in a value would be expanded by String.replace, which both corrupts
    // the prompt and injects text that never appeared in the input.
    const rendered = renderTemplate(template, {
      first_name: '$& $1',
      reference: 'the campaign',
      channel: 'email',
    });
    expect(rendered).toContain('$& $1');
  });

  it('declares every slot its body actually uses', () => {
    // A body referencing an undeclared slot can never be rendered — every call
    // would fail the undeclared/missing check.
    for (const template of PROMPT_TEMPLATES) {
      const used = [...template.body.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);
      for (const slot of used) {
        expect(template.slots).toContain(slot);
      }
    }
  });
});

/** Rows in the activity ledger. */
async function ledgerCount(): Promise<number> {
  const row = await dataService.queryOne<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM ai_completion',
    []
  );
  return parseInt(row!.count, 10);
}

/** The most recent ledger entry. */
async function latestCompletion(): ReturnType<typeof completionById> {
  const row = await dataService.queryOne<{ id: string }>(
    'SELECT id FROM ai_completion ORDER BY created_at DESC, id DESC LIMIT 1',
    []
  );
  return row ? completionById(row.id) : null;
}
