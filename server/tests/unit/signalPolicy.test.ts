import { Response } from 'express';
import {
  SIGNAL_RULES,
  classifySignal,
  knownSignalKinds,
} from '../../src/features/intake/signalPolicy';
import { IntakeController } from '../../src/features/intake/intakeController';
import { GovernedRequest } from '../../src/platform/policy/governed';
import * as auditLog from '../../src/platform/audit/auditLog';

/**
 * The SOP §03 signal table.
 *
 * The acceptance case — "an anonymous page view provably creates no sales
 * record and no identity" — is a NEGATIVE, and a negative about something the
 * system must decline to do. Nothing visibly breaks if it regresses: a lead
 * appears where there should be none, indistinguishable from a real one, with
 * an identity nobody consented to.
 */

function fakeRes(): Response & { code: number; body: unknown } {
  const res = {
    code: 0,
    body: undefined as unknown,
    status(value: number) {
      res.code = value;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { code: number; body: unknown };
}

function req(body: Record<string, unknown>): GovernedRequest {
  return {
    params: {},
    body,
    query: {},
    session: { userId: 'u1', role: 'user' },
  } as unknown as GovernedRequest;
}

beforeEach(() => {
  jest.spyOn(auditLog, 'appendAuditEntry').mockResolvedValue({ delivered: true, entryRef: 'aud' });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('anonymous engagement creates nothing', () => {
  it('an anonymous page view creates NO record and NO identity', () => {
    // The task's stated acceptance case, asserted as the two separate refusals
    // it actually is.
    const result = classifySignal('page_view', { identifiable: false });

    expect(result.decision).toBe('NO_RECORD');
    expect(result.createsRecord).toBe(false);
    expect(result.mayInferIdentity).toBe(false);
  });

  it('treats a like, a view and an impression the same way', () => {
    for (const kind of ['like', 'view', 'impression', 'anonymous_visit', 'scroll']) {
      const result = classifySignal(kind, { identifiable: false });
      expect(result.decision).toBe('NO_RECORD');
      expect(result.mayInferIdentity).toBe(false);
    }
  });

  it('creates NOTHING even when the viewer happens to be identifiable', () => {
    // Knowing WHO viewed a page does not make the view a sales signal. If being
    // identifiable were enough, every logged-in browse would manufacture a lead.
    const result = classifySignal('page_view', { identifiable: true });

    expect(result.decision).toBe('NO_RECORD');
    expect(result.mayInferIdentity).toBe(false);
  });

  it('still allows anonymous retargeting, which needs no identity', () => {
    const result = classifySignal('impression', { identifiable: false });

    expect(result.actions).toContain('retarget_anonymously');
  });

  it('DEFAULTS to no record for a signal the table does not describe', () => {
    // An unclassified signal is one nobody has decided about. Guessing CREATE
    // would let an unreviewed event type manufacture leads and identities.
    const result = classifySignal('some_new_event_type', { identifiable: true });

    expect(result.decision).toBe('NO_RECORD');
    expect(result.ruleKey).toBe('unmatched');
    expect(result.mayInferIdentity).toBe(false);
  });
});

describe('every rule routes with a recorded reason', () => {
  it('gives every rule in the table a substantial reason', () => {
    for (const rule of SIGNAL_RULES) {
      // A classification with no stated basis is unauditable six months later.
      expect(rule.reason.length).toBeGreaterThan(60);
    }
  });

  it('returns the reason WITH the decision, not just in the config', () => {
    const result = classifySignal('lead_form', { identifiable: true });
    expect(result.reason.length).toBeGreaterThan(60);
    // And the rule that decided, so the table row is traceable from the outcome.
    expect(result.ruleKey).toBe('lead_form');
  });

  it('gives a reason even when it refuses', () => {
    expect(classifySignal('page_view', { identifiable: false }).reason.length).toBeGreaterThan(60);
    expect(classifySignal('unknown_thing', { identifiable: false }).reason.length).toBeGreaterThan(
      60
    );
  });

  it('routes a lead form to CREATE with the SLA clock', () => {
    const result = classifySignal('website_lead_form', { identifiable: false });

    expect(result.decision).toBe('CREATE');
    expect(result.priority).toBe('high');
    expect(result.actions).toEqual(
      expect.arrayContaining(['acknowledge', 'assign_owner', 'start_sla_clock'])
    );
  });

  it('routes a DM to CREATE but VERIFIES the contact data', () => {
    const result = classifySignal('dm', { identifiable: false });

    expect(result.decision).toBe('CREATE');
    // A DM handle is not an email address; treating it as one produces a record
    // nobody can contact.
    expect(result.actions).toContain('capture_and_verify_contact_data');
  });

  it('routes a completed purchase to CLOSED WON, not to a lead', () => {
    const result = classifySignal('license_purchase_completed', { identifiable: true });

    expect(result.decision).toBe('CLOSED_WON');
    // Creating a lead here would put a paying customer back into a sales
    // sequence.
    expect(result.actions).toContain('stop_sales_sequences');
  });

  it('names no duplicate signal kind across rules', () => {
    // First-match-wins makes a duplicate silently unreachable, and the
    // unreachable one is whichever rule somebody added second.
    const kinds = knownSignalKinds();
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe('an interested comment needs an identifiable person', () => {
  it('CREATES when the commenter is identifiable', () => {
    const result = classifySignal('comment_interested', { identifiable: true });

    expect(result.decision).toBe('CREATE');
    expect(result.actions).toContain('public_acknowledgement');
    // Answered privately, because the reply carries information the commenter
    // may not want under a public post.
    expect(result.actions).toContain('compliant_private_reply');
  });

  it('REFUSES when they are not, rather than inventing an identity', () => {
    const result = classifySignal('comment_interested', { identifiable: false });

    // The distinction the whole table turns on: the same word from an account
    // we cannot resolve is not a lead.
    expect(result.decision).toBe('NO_RECORD');
    expect(result.mayInferIdentity).toBe(false);
  });

  it('explains the near miss rather than refusing bare', () => {
    const result = classifySignal('comment_interested', { identifiable: false });

    // "This would have been a lead if we could tell who it was" is the useful
    // fact, and it names the rule that would have applied.
    expect(result.ruleKey).toBe('interested_comment');
    expect(result.reason).toContain('could not be identified');
  });
});

describe('a known contact revisiting pricing', () => {
  it('MERGES rather than creating a second record', () => {
    const result = classifySignal('pricing_revisit', {
      identifiable: true,
      existingLeadId: 'lead-1',
    });

    // A second record splits their history.
    expect(result.decision).toBe('MERGE');
  });

  it('rescores AND pauses generic nurture', () => {
    const result = classifySignal('pricing_revisit', { identifiable: true });

    expect(result.actions).toContain('rescore');
    // Leaving nurture running at somebody actively evaluating is the failure
    // this prevents.
    expect(result.actions).toContain('pause_generic_nurture');
    expect(result.actions).toContain('create_urgent_owner_task');
  });

  it('does NOT merge an unidentifiable pricing visit', () => {
    // There is nothing to merge into, and inventing the match would attach a
    // stranger's visit to a real person's record.
    expect(classifySignal('pricing_revisit', { identifiable: false }).decision).toBe('NO_RECORD');
  });
});

describe('checkout started is the highest priority in the table', () => {
  it('is the ONLY rule rated highest', () => {
    const highest = SIGNAL_RULES.filter((rule) => rule.priority === 'highest');

    // If everything is highest, nothing is. Someone who tried to pay and was
    // stopped outranks every other signal here.
    expect(highest).toHaveLength(1);
    expect(highest[0].key).toBe('checkout_started');
  });

  it('creates a payment-assistance task and same-day outreach', () => {
    const result = classifySignal('checkout_started', { identifiable: false });

    expect(result.decision).toBe('CREATE');
    expect(result.priority).toBe('highest');
    expect(result.actions).toContain('create_payment_assistance_task');
    // "when allowed" — the outreach is conditional on permission, and the
    // action name says so rather than assuming it.
    expect(result.actions).toContain('same_day_rep_outreach_if_permitted');
  });

  it('is not swallowed by a broader web rule', () => {
    // Rule ORDER is what protects this. A generic web rule matching first would
    // silently demote the most valuable signal in the table.
    const checkoutIndex = SIGNAL_RULES.findIndex((r) => r.key === 'checkout_started');
    const leadFormIndex = SIGNAL_RULES.findIndex((r) => r.key === 'lead_form');
    expect(checkoutIndex).toBeLessThan(leadFormIndex);
  });

  it('treats an abandoned cart and a failed payment the same way', () => {
    for (const kind of ['cart_abandoned', 'payment_failed']) {
      expect(classifySignal(kind, { identifiable: false }).priority).toBe('highest');
    }
  });
});

describe('the classify endpoint', () => {
  it('answers 200 with the decision and its reasoning', async () => {
    const res = fakeRes();
    await IntakeController.classify(req({ signalKind: 'lead_form', identifiable: true }), res);

    // 200, not 201: nothing was stored, and 201 would suggest the
    // classification itself made a record.
    expect(res.code).toBe(200);
    const data = (res.body as { data: { decision: string; reason: string } }).data;
    expect(data.decision).toBe('CREATE');
    expect(data.reason.length).toBeGreaterThan(60);
  });

  it('treats a MISSING identifiable flag as false', async () => {
    const res = fakeRes();
    await IntakeController.classify(req({ signalKind: 'comment_interested' }), res);

    // An unstated flag must not read as "yes" — that would turn an anonymous
    // comment into a lead on the strength of a missing field.
    expect((res.body as { data: { decision: string } }).data.decision).toBe('NO_RECORD');
  });

  it('refuses a request with no signal kind', async () => {
    await expect(IntakeController.classify(req({}), fakeRes())).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
