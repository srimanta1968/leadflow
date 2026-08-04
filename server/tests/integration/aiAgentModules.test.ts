import { randomUUID } from 'crypto';
import { COACHING_DIMENSIONS, APPROVED_OBJECTIONS, LACE_STEPS } from '../../src/config/coachingScorecard';
import {
  RESEARCH_SOURCES,
  DEFAULT_RESEARCH_SOURCES,
  partitionRequestedSources,
} from '../../src/config/researchSources';
import { findOfferTruthViolations, assertOfferTruth } from '../../src/features/ai/offerTruth';
import { acceptProposal, qualifyLead } from '../../src/features/ai/sdrQualifyService';
import { mapObjection, registerCall, scoreCall } from '../../src/features/ai/coachScorecardService';
import { verifyRecordingBasis } from '../../src/features/ai/recordingConsent';
import { dataService } from '../../src/services/DataService';
import * as auditLog from '../../src/platform/audit/auditLog';

/**
 * The AI SDR and Sales Coach modules.
 *
 * Integration, because the guarantees are enforced against real rows: a
 * proposal that starts un-sendable, provenance written per fact, and a consent
 * gate that reads the call's actual basis. A mocked data layer would assert the
 * mock.
 */

let leadId: string;

beforeAll(async () => {
  await dataService.query("DELETE FROM leads WHERE name LIKE 'AI-TEST%'", []);
  await dataService.query("DELETE FROM ai_coach_call WHERE external_call_id LIKE 'ai-test-%'", []);

  const row = await dataService.queryOne<{ id: string }>(
    `INSERT INTO leads (name, email, source, utm_campaign, activation_state)
     VALUES ('AI-TEST Dana Okafor', 'dana.okafor@example.test', 'web_form', 'spring-launch', 'active')
     RETURNING id`,
    []
  );
  leadId = row!.id;
});

describe('the permitted research registry (AC2)', () => {
  it('refuses a source outside the registry', () => {
    const { permitted, refused } = partitionRequestedSources([
      'submitted_form_content',
      'scraped_social_profile',
    ]);
    expect(permitted).toEqual(['submitted_form_content']);
    expect(refused).toEqual(['scraped_social_profile']);
  });

  it('reports EVERY refusal, not just the first', () => {
    // A caller naming three bad sources should be told about three, not asked
    // to discover them one request at a time.
    const { refused } = partitionRequestedSources(['a', 'b', 'c']);
    expect(refused).toHaveLength(3);
  });

  it('defaults to sources that cost nothing', () => {
    // The Quick Capture surface promises no paid enrichment, and a research
    // step that silently spent credits would make that promise false elsewhere
    // in the product.
    for (const key of DEFAULT_RESEARCH_SOURCES) {
      expect(RESEARCH_SOURCES.find((s) => s.key === key)!.costCredits).toBe(0);
    }
  });

  it('rejects a qualify request naming an unpermitted source', async () => {
    await expect(
      qualifyLead({ leadId, channel: 'email', researchSources: ['scraped_social_profile'] })
    ).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_PERMITTED' });
  });

  it('RECORDS PROVENANCE per fact, not per proposal', async () => {
    const proposal = await qualifyLead({ leadId, channel: 'email' });

    const facts = await dataService.query<{ source_key: string; fact_key: string }>(
      'SELECT source_key, fact_key FROM ai_research_fact WHERE proposal_id = $1',
      [proposal.id]
    );

    // "Where did this specific claim about the prospect come from" is the only
    // question provenance has to answer, and a blob on the proposal cannot.
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(RESEARCH_SOURCES.some((s) => s.key === fact.source_key)).toBe(true);
    }
  });

  it('reports permitted sources it could not reach', async () => {
    const proposal = await qualifyLead({ leadId, channel: 'email' });
    // Partial research that looks complete is the failure mode: a rep cannot
    // otherwise tell "found nothing" from "never ran".
    expect(Array.isArray(proposal.researchUnavailable)).toBe(true);
  });
});

describe('AI SDR output is a PROPOSAL (AC1)', () => {
  it('produces a proposal that is not sent and cannot be', async () => {
    const proposal = await qualifyLead({ leadId, channel: 'email' });
    expect(proposal.status).toBe('proposed');
    expect(proposal.sent).toBe(false);
  });

  it('has no sent state available in the schema at all', async () => {
    // The guarantee is structural, not a runtime check: a status enum
    // containing 'sent' would be an invitation to write the code that sets it.
    const proposal = await qualifyLead({ leadId, channel: 'email' });
    await expect(
      dataService.query("UPDATE ai_sdr_proposal SET status = 'sent' WHERE id = $1", [proposal.id])
    ).rejects.toBeDefined();
  });

  it('attributes every point to the criterion that awarded it', async () => {
    const proposal = await qualifyLead({ leadId, channel: 'email' });

    const summed = proposal.scoreAttribution.reduce((total, c) => total + c.awarded, 0);
    expect(summed).toBe(proposal.score);
    for (const component of proposal.scoreAttribution) {
      // A score a rep cannot interrogate is one they will over-trust or ignore.
      expect(component.because.length).toBeGreaterThan(20);
      expect(component.awarded).toBeLessThanOrEqual(component.max);
    }
  });

  it('scores the same lead the same way twice', async () => {
    // A rep who watches a lead move from 62 to 71 with nothing changed stops
    // believing any of it. This is why scoring is not a model call.
    const first = await qualifyLead({ leadId, channel: 'email' });
    const second = await qualifyLead({ leadId, channel: 'email' });
    expect(second.score).toBe(first.score);
  });

  it('requires a rep to accept before anything is sendable', async () => {
    const proposal = await qualifyLead({ leadId, channel: 'email' });
    const userId = null;

    const accepted = await acceptProposal({
      proposalId: proposal.id,
      userId,
      acceptedAsWritten: true,
      editedBody: null,
    });

    expect(accepted.status).toBe('accepted');
    expect(accepted.bodyToSend).toBe(proposal.draftBody);
  });

  it('keeps the rep edit ALONGSIDE the original draft', async () => {
    const proposal = await qualifyLead({ leadId, channel: 'email' });
    await acceptProposal({
      proposalId: proposal.id,
      userId: null,
      acceptedAsWritten: false,
      editedBody: 'Hi Dana, following up on your enquiry. Do you have ten minutes tomorrow?',
    });

    const row = await dataService.queryOne<{ draft_body: string; edited_body: string }>(
      'SELECT draft_body, edited_body FROM ai_sdr_proposal WHERE id = $1',
      [proposal.id]
    );
    // Overwriting would destroy the only evidence of what the model actually
    // produced — exactly the record needed to tell whether drafts are improving.
    expect(row!.draft_body).toBe(proposal.draftBody);
    expect(row!.edited_body).not.toBe(row!.draft_body);
  });

  it('refuses a second acceptance rather than silently ignoring it', async () => {
    const proposal = await qualifyLead({ leadId, channel: 'email' });
    await acceptProposal({
      proposalId: proposal.id,
      userId: null,
      acceptedAsWritten: true,
      editedBody: null,
    });

    // Two acceptances mean two people each believed they were releasing the
    // message. Answering 200 to both hides a coordination failure.
    await expect(
      acceptProposal({
        proposalId: proposal.id,
        userId: null,
        acceptedAsWritten: true,
        editedBody: null,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('404s for an unknown lead', async () => {
    await expect(
      qualifyLead({ leadId: '00000000-0000-0000-0000-000000000000', channel: 'email' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('offer-truth constraints', () => {
  it('rejects a guaranteed result', () => {
    const violations = findOfferTruthViolations('We guarantee you will double your close rate.');
    expect(violations.map((v) => v.rule)).toContain('guaranteed_result');
  });

  it('rejects a roadmap date', () => {
    // The SOP: no guaranteed date unless it is written in the approved terms,
    // and a first-touch email is never the approved terms.
    const violations = findOfferTruthViolations('That is on the roadmap and ships in March.');
    expect(violations.map((v) => v.rule)).toContain('roadmap_date');
  });

  it('rejects an unapproved discount', () => {
    const violations = findOfferTruthViolations('I can do 20% off if you sign this week.');
    expect(violations.map((v) => v.rule)).toContain('unapproved_discount');
  });

  it('rejects manufactured urgency', () => {
    const violations = findOfferTruthViolations('Last chance — only 3 seats left.');
    expect(violations.map((v) => v.rule)).toContain('fake_urgency');
  });

  it('reports EVERY violation, not the first', () => {
    // A draft with three problems should come back with three, or the author
    // fixes one and resubmits into the next.
    const violations = findOfferTruthViolations(
      'We guarantee results, 20% off, and act now before it expires today.'
    );
    expect(violations.length).toBeGreaterThan(2);
  });

  it('leaves ordinary sales language alone', () => {
    // A rule that fires on normal copy gets switched off within a week, and a
    // disabled guardrail protects nothing.
    expect(
      findOfferTruthViolations(
        'Thanks for reaching out. I will call you shortly to understand what caught your attention.'
      )
    ).toEqual([]);
  });

  it('applies to a REP EDIT, not just a generated draft', async () => {
    const proposal = await qualifyLead({ leadId, channel: 'email' });
    // An unapproved discount is no more approved for having been typed by a
    // person.
    await expect(
      acceptProposal({
        proposalId: proposal.id,
        userId: null,
        acceptedAsWritten: false,
        editedBody: 'Hi Dana, I can offer 30% off if you decide today.',
      })
    ).rejects.toMatchObject({ code: 'OFFER_TRUTH_VIOLATION' });
  });

  it('throws with the offending phrase quoted', () => {
    // A rejection the author cannot act on is only marginally better than a
    // silent edit.
    expect(() => assertOfferTruth('We guarantee results.', 'Draft')).toThrow(/guarantee/i);
  });
});

describe('the SOP coaching scorecard (AC3)', () => {
  it('is exactly the SOP ten, in the SOP order', () => {
    expect(COACHING_DIMENSIONS.map((d) => d.label)).toEqual([
      'Opening/context',
      'Agenda contract',
      'Question quality',
      'Listening',
      'Problem/impact depth',
      'Tailored demo',
      'Feature-status honesty',
      'Objection diagnosis',
      'Clear ask',
      'Scheduled NEXT',
    ]);
  });

  it('says "Listening", not "listening ratio"', () => {
    // The ratio is one way to MEASURE the dimension, not the dimension — a rep
    // can hold a perfect talk/listen ratio while hearing nothing. Renaming it
    // would also stop the screen matching the paper form the manager coaches
    // from.
    const listening = COACHING_DIMENSIONS.find((d) => d.key === 'listening');
    expect(listening!.label).toBe('Listening');
  });

  it('carries the LACE steps in order', () => {
    // The order IS the method: acknowledging before listening is placation, and
    // executing before clarifying is the reflexive rebuttal LACE prevents.
    expect(LACE_STEPS.map((s) => s.label)).toEqual([
      'Listen',
      'Acknowledge',
      'Clarify',
      'Execute a next step',
    ]);
  });

  it('maps a heard objection to the APPROVED response', () => {
    const mapped = mapObjection('It is too expensive');
    expect(mapped.key).toBe('too_expensive');
    expect(mapped.unmapped).toBe(false);
    expect(mapped.approvedResponse).toBe(
      APPROVED_OBJECTIONS.find((o) => o.key === 'too_expensive')!.response
    );
  });

  it('reports an unrecognised objection as UNMAPPED rather than inventing one', () => {
    const mapped = mapObjection('Your logo is the wrong shade of blue');
    // An invented rebuttal is how an unapproved claim reaches a prospect
    // wearing the authority of the SOP — and it would carry that authority
    // precisely because it appeared in the coaching tool.
    expect(mapped.unmapped).toBe(true);
    expect(mapped.approvedResponse).toBeNull();
  });
});

describe('the recording consent gate (AC4)', () => {
  async function registerTestCall(withBasis: boolean): Promise<string> {
    const external = `ai-test-${randomUUID()}`;
    if (!withBasis) {
      const row = await dataService.queryOne<{ id: string }>(
        `INSERT INTO ai_coach_call
           (external_call_id, rep_email, occurred_at, recording_consent_basis_ref,
            recording_consent_captured_at)
         VALUES ($1, 'rep@example.test', CURRENT_TIMESTAMP, 'x', CURRENT_TIMESTAMP)
         RETURNING id`,
        [external]
      );
      return row!.id;
    }
    const call = await registerCall({
      externalCallId: external,
      repEmail: 'rep@example.test',
      leadId: null,
      occurredAt: new Date().toISOString(),
      recordingConsentBasisRef: randomUUID(),
      recordingConsentCapturedAt: new Date().toISOString(),
    });
    return call.id;
  }

  it('refuses to register a call with no recording basis', async () => {
    // A row with a blank basis is indistinguishable a month later from one
    // where consent was genuinely obtained and simply not written down.
    await expect(
      registerCall({
        externalCallId: `ai-test-${randomUUID()}`,
        repEmail: 'rep@example.test',
        leadId: null,
        occurredAt: new Date().toISOString(),
        recordingConsentBasisRef: null,
        recordingConsentCapturedAt: null,
      })
    ).rejects.toMatchObject({ code: 'RECORDING_CONSENT_MISSING' });
  });

  it('refuses an unregistered call with the SAME answer as an unconsented one', async () => {
    const verdict = await verifyRecordingBasis('00000000-0000-0000-0000-000000000000');
    // Distinguishing them would let anyone enumerate which call ids exist by
    // reading the status code.
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBe('no_registered_call_with_recording_basis');
  });

  it('refuses to score a call whose basis cannot be verified', async () => {
    const callId = await registerTestCall(true);
    // Fails closed. A revocation we cannot see is precisely the case this
    // protects against — and unlike an unreachable capture policy, the
    // restriction here is written in the SOP rather than invented by the gate.
    await expect(scoreCall(callId)).rejects.toMatchObject({
      code: 'RECORDING_CONSENT_MISSING',
    });
  });

  it('scores the call when an operator has accepted local-only verification', async () => {
    const previous = process.env.AI_RECORDING_CONSENT_LOCAL_ONLY;
    process.env.AI_RECORDING_CONSENT_LOCAL_ONLY = 'true';
    try {
      const callId = await registerTestCall(true);
      const scorecard = await scoreCall(callId);

      expect(scorecard.dimensionCount).toBe(10);
      // The verification METHOD is stamped onto the artefact: "was this call
      // lawfully processed" is asked about the output, long after any log line
      // has scrolled away.
      expect(scorecard.consentVerification.method).toBe('local_basis_only');
    } finally {
      process.env.AI_RECORDING_CONSENT_LOCAL_ONLY = previous;
    }
  });

  it('scores every dimension null rather than zero when no analysis is available', async () => {
    const previous = process.env.AI_RECORDING_CONSENT_LOCAL_ONLY;
    process.env.AI_RECORDING_CONSENT_LOCAL_ONLY = 'true';
    try {
      const callId = await registerTestCall(true);
      const scorecard = await scoreCall(callId);

      // A call nobody analysed and a call that opened badly are different
      // facts. A zero would put a rep on a performance plan for an outage.
      for (const dimension of scorecard.dimensions) {
        expect(dimension.score).toBeNull();
      }
    } finally {
      process.env.AI_RECORDING_CONSENT_LOCAL_ONLY = previous;
    }
  });

  it('RECORDS THE REFUSAL in the audit ledger', async () => {
    const appended = jest.spyOn(auditLog, 'appendAuditEntry');
    try {
      const callId = await registerTestCall(true);
      await expect(scoreCall(callId)).rejects.toMatchObject({
        code: 'RECORDING_CONSENT_MISSING',
      });

      // An absent entry cannot distinguish "we declined to process this call"
      // from "nobody ever asked", and only the first is evidence the gate works.
      // It has to be appended BEFORE the throw, because after it there is no
      // code path left to append from — which is exactly how the `governed`
      // wrapper, appending only on success, would have lost it.
      const events = appended.mock.calls.map((call) => call[0].event);
      expect(events).toContain('ai.coach.refused_no_consent');
    } finally {
      appended.mockRestore();
    }
  });

  it('does not put the consent basis reference into the ledger', async () => {
    const appended = jest.spyOn(auditLog, 'appendAuditEntry');
    try {
      const callId = await registerTestCall(true);
      await expect(scoreCall(callId)).rejects.toBeDefined();

      // The refusal is the fact. The pointer into the consent service is not
      // the ledger's business, and the ledger has a wider audience.
      const serialised = JSON.stringify(appended.mock.calls);
      const call = await dataService.queryOne<{ recording_consent_basis_ref: string }>(
        'SELECT recording_consent_basis_ref FROM ai_coach_call WHERE id = $1',
        [callId]
      );
      expect(serialised).not.toContain(call!.recording_consent_basis_ref);
    } finally {
      appended.mockRestore();
    }
  });

  it('stores NO transcript content locally', async () => {
    const callId = await registerTestCall(true);
    const columns = await dataService.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_coach_call'`,
      []
    );
    // The safest place to keep call content is somewhere it never was: a call
    // whose consent is revoked then has nothing here to purge.
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('transcript');
    expect(names).not.toContain('recording_url');
    expect(callId).toBeTruthy();
  });
});
