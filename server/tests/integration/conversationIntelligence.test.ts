import { randomUUID } from 'crypto';
import { ruleFor, allJurisdictionCodes } from '../../src/config/recordingJurisdictions';
import { dataService } from '../../src/services/DataService';
import {
  analyseRecording,
  artifactsFor,
  captureRecording,
  markStored,
} from '../../src/features/conversation/intelligencePipeline';
import { appendCustody, custodyChain, verifyChain } from '../../src/features/conversation/custodyLedger';
import { checkRecordingEligibility } from '../../src/features/conversation/recordingEligibility';

/**
 * The conversation intelligence pipeline.
 *
 * INTEGRATION, because three of the four criteria are enforced by the SCHEMA —
 * NOT NULL offsets, an append-only trigger, a NOT NULL consent basis — and only
 * a real database can be asked whether those hold. A mocked data layer would
 * assert that the mock allows what the mock allows.
 *
 * The suite runs with no gateway (tests/setup.ts), so the consent service is
 * unreachable, which is the branch AC1's fail-closed behaviour lives on.
 */

const MARK = 'CONV-TEST';

/** A basis the local-only path will accept, for the tests that need to get past AC1. */
function withLocalConsent<T>(run: () => Promise<T>): Promise<T> {
  process.env.AI_RECORDING_CONSENT_LOCAL_ONLY = 'true';
  return run().finally(() => {
    delete process.env.AI_RECORDING_CONSENT_LOCAL_ONLY;
  });
}

/** Capture a recording in a one-party jurisdiction, which needs no extra consent. */
async function captured(externalCallId = `${MARK}-${randomUUID()}`): Promise<string> {
  const recording = await withLocalConsent(() =>
    captureRecording({
      externalCallId,
      consentBasisRef: `rcpt_${randomUUID()}`,
      jurisdiction: 'US-TX',
      actor: 'service:test',
    })
  );
  return recording.id;
}

/**
 * THIS SUITE DELETES NOTHING, and that is a property of the design rather than
 * an oversight.
 *
 * A recording with a custody chain CANNOT be deleted: the chain's foreign key is
 * ON DELETE RESTRICT and the chain itself refuses DELETE outright. Attempting
 * the usual `DELETE FROM call_recording WHERE ...` cleanup is how that was
 * discovered — it fails with "call_custody_event is append-only", which is the
 * constraint doing exactly what it exists for. Every test therefore uses a
 * unique external call id and leaves its rows behind, which is also what
 * production does: media is purged upstream in sdk-media and recorded here as a
 * `purged` link, never as a row removal.
 */
afterEach(() => {
  delete process.env.AI_RECORDING_CONSENT_LOCAL_ONLY;
});

// ---------------------------------------------------------------------------
// AC1 — recording blocked without a verified basis, with the reason shown
// ---------------------------------------------------------------------------

describe('the pre-call recording gate (AC1)', () => {
  it('blocks with a rep-facing reason and a remedy when no basis is held', async () => {
    const verdict = await checkRecordingEligibility({ jurisdiction: 'US-TX' });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockCode).toBe('no_consent_basis');
    // The reason has to be something a rep can ACT on. "consent_not_verified"
    // tells them nothing; this tells them what to do next.
    expect(verdict.reason).toMatch(/No recording consent has been captured/);
    expect(verdict.remedy).toMatch(/Ask on the call/);
  });

  it('blocks in an all-party jurisdiction even WITH a good basis', async () => {
    const verdict = await withLocalConsent(() =>
      checkRecordingEligibility({
        consentBasisRef: `rcpt_${randomUUID()}`,
        jurisdiction: 'US-CA',
      })
    );

    // The stored receipt is a standing permission from an earlier interaction.
    // An all-party rule exists precisely to make somebody ask again on THIS
    // call, so a receipt alone must not satisfy it.
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockCode).toBe('all_party_consent_required');
    expect(verdict.reason).toMatch(/California requires every party/);
  });

  it('allows the same call once consent is captured on it', async () => {
    const verdict = await withLocalConsent(() =>
      checkRecordingEligibility({
        consentBasisRef: `rcpt_${randomUUID()}`,
        jurisdiction: 'US-CA',
        allPartyConsentCaptured: true,
      })
    );

    expect(verdict.allowed).toBe(true);
    expect(verdict.blockCode).toBeNull();
  });

  it('treats an UNKNOWN jurisdiction as all-party, not as permitted', async () => {
    const verdict = await withLocalConsent(() =>
      checkRecordingEligibility({
        consentBasisRef: `rcpt_${randomUUID()}`,
        jurisdiction: 'ZZ-QQ',
      })
    );

    // "We had not got round to adding that state" must never be the reason a
    // call was recorded unlawfully. Strict by default, with a lawful path out.
    expect(ruleFor('ZZ-QQ').rule).toBe('all_party');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/strictest one applies/);
  });

  it('fails closed when the consent service cannot be reached', async () => {
    // No gateway, and no explicit local-only opt-in. An unverifiable basis means
    // we cannot show the call was lawfully recorded, and a revocation we cannot
    // see is exactly what this protects against.
    const verdict = await checkRecordingEligibility({
      consentBasisRef: `rcpt_${randomUUID()}`,
      jurisdiction: 'US-TX',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockCode).toBe('consent_not_verified');
    // No false hope: the remedy names the honest options rather than implying a
    // retry will help.
    expect(verdict.remedy).toMatch(/Capture fresh consent|continue without recording/);
  });

  it('writes NO recording row when the gate refuses', async () => {
    const externalCallId = `${MARK}-blocked-${randomUUID()}`;

    await expect(
      captureRecording({ externalCallId, jurisdiction: 'US-TX', actor: 'service:test' })
    ).rejects.toMatchObject({ code: 'RECORDING_CONSENT_MISSING' });

    const row = await dataService.queryOne<{ id: string }>(
      'SELECT id FROM call_recording WHERE external_call_id = $1',
      [externalCallId]
    );
    // A row for a recording that was never made is how a table of recordings
    // stops meaning what it says.
    expect(row).toBeNull();
  });

  it('offers the jurisdictions it actually knows, so a picker cannot drift', () => {
    expect(allJurisdictionCodes()).toContain('US-CA');
    expect(allJurisdictionCodes()).toContain('US-TX');
  });
});

// ---------------------------------------------------------------------------
// AC2 — every derived artifact traces back to a timestamp in the recording
// ---------------------------------------------------------------------------

describe('artifact traceability (AC2)', () => {
  it('cannot insert an artifact with no source offset', async () => {
    const recordingId = await captured();

    // The criterion enforced by the SCHEMA, not only by the pipeline above it:
    // a future caller bypassing the service layer gets a NOT NULL violation
    // rather than an untraceable artifact.
    await expect(
      dataService.query(
        `INSERT INTO call_artifact (recording_id, kind, produced_by, content, source_start_ms, source_end_ms)
         VALUES ($1, 'summary', 'test', '{}'::jsonb, NULL, NULL)`,
        [recordingId]
      )
    ).rejects.toThrow(/source_start_ms/);
  });

  it('refuses an interval that ends before it starts', async () => {
    const recordingId = await captured();

    // Not a pedantic check: a backwards span produces an unplayable "jump to
    // this moment" link, which fails in the reviewer's hands rather than here.
    await expect(
      dataService.query(
        `INSERT INTO call_artifact (recording_id, kind, produced_by, content, source_start_ms, source_end_ms)
         VALUES ($1, 'summary', 'test', '{}'::jsonb, 5000, 1000)`,
        [recordingId]
      )
    ).rejects.toThrow(/call_artifact_span_ck/);
  });

  it('gives EVERY artifact from a full run a citable span', async () => {
    const recordingId = await captured();

    await analyseRecording({
      recordingId,
      actor: 'service:test',
      segments: [
        { speaker: 'rep', text: 'Thanks for taking my call today.', startMs: 0, endMs: 4000 },
        { speaker: 'prospect', text: 'It is too expensive for us right now.', startMs: 4000, endMs: 9000 },
        { speaker: 'rep', text: "I will send you the breakdown.", startMs: 9000, endMs: 13000 },
      ],
    });

    const artifacts = await artifactsFor(recordingId);

    expect(artifacts.length).toBeGreaterThan(5);
    for (const artifact of artifacts) {
      expect(Number.isInteger(artifact.sourceStartMs)).toBe(true);
      expect(Number.isInteger(artifact.sourceEndMs)).toBe(true);
      expect(artifact.sourceEndMs).toBeGreaterThanOrEqual(artifact.sourceStartMs);
    }

    // The objection cites the moment it was heard, not the whole call — that is
    // the difference between a claim somebody can check in eleven seconds and
    // an opinion.
    const objection = artifacts.find((artifact) => artifact.kind === 'objection');
    expect(objection).toBeDefined();
    expect(objection!.sourceStartMs).toBe(4000);
    expect(objection!.sourceEndMs).toBe(9000);
    expect(objection!.content.family).toBe('price');

    // The summary spans the whole call, which is the honest span for a summary.
    const summary = artifacts.find((artifact) => artifact.kind === 'summary');
    expect(summary!.sourceStartMs).toBe(0);
    expect(summary!.sourceEndMs).toBe(13000);
  });

  it('walks a deal-risk signal back to the artifacts it was computed from', async () => {
    const recordingId = await captured();

    await analyseRecording({
      recordingId,
      actor: 'service:test',
      segments: [
        { speaker: 'prospect', text: 'That is too expensive, and it is a bad time.', startMs: 0, endMs: 6000 },
      ],
    });

    const artifacts = await artifactsFor(recordingId);
    const risk = artifacts.find((artifact) => artifact.kind === 'deal_risk')!;
    const derivedFrom = risk.content.derivedFrom as string[];

    // A risk number nobody can trace is a number nobody can argue with.
    expect(derivedFrom.length).toBeGreaterThan(0);
    for (const id of derivedFrom) {
      expect(artifacts.map((artifact) => artifact.id)).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — PII redacted before leaving the tenant boundary for analysis
// ---------------------------------------------------------------------------

describe('redaction before analysis (AC3)', () => {
  it('stores no contact point from the transcript, and records what it removed', async () => {
    const recordingId = await captured();

    await analyseRecording({
      recordingId,
      actor: 'service:test',
      segments: [
        {
          speaker: 'prospect',
          text: 'Email me at dana.okafor@example.test or ring +44 7700 900123.',
          startMs: 0,
          endMs: 5000,
        },
      ],
    });

    const artifacts = await artifactsFor(recordingId);
    const stored = JSON.stringify(artifacts);

    // The redaction runs ONCE at the top of the pipeline and every stage reads
    // the redacted text, so there is no path by which raw text reaches storage
    // or the gateway.
    expect(stored).not.toMatch(/dana\.okafor@example\.test/);
    expect(stored).not.toMatch(/7700/);
    expect(stored).toMatch(/\{\{email\}\}/);

    const segment = artifacts.find((artifact) => artifact.kind === 'transcript_segment')!;
    const rules = segment.redactionApplied.map((hit) => hit.rule).sort();
    // Counts, so "the rules ran and matched nothing" is distinguishable from
    // "the rules were misconfigured".
    expect(rules).toEqual(['email', 'phone']);
  });

  it('records the redaction in the custody chain as counts, never values', async () => {
    const recordingId = await captured();

    await analyseRecording({
      recordingId,
      actor: 'service:test',
      segments: [
        { speaker: 'rep', text: 'My address is rep@example.test.', startMs: 0, endMs: 3000 },
      ],
    });

    const chain = await custodyChain(recordingId);
    const redactionLink = chain.find((entry) => entry.stage === 'redacted');

    expect(redactionLink).toBeDefined();
    expect(redactionLink!.detail).toMatch(/spans removed/);
    // The chain must not become the one place holding what the redaction took
    // out of everywhere else.
    expect(JSON.stringify(chain)).not.toMatch(/rep@example\.test/);
  });
});

// ---------------------------------------------------------------------------
// AC4 — chain of custody maintained for every recording
// ---------------------------------------------------------------------------

describe('chain of custody (AC4)', () => {
  it('records a link for every stage, in order', async () => {
    const recordingId = await captured();
    await markStored(recordingId, 'blob_test', 'sha256:abc', 'service:test');
    await analyseRecording({
      recordingId,
      actor: 'service:test',
      segments: [{ speaker: 'rep', text: 'Hello there.', startMs: 0, endMs: 2000 }],
    });

    const chain = await custodyChain(recordingId);
    const stages = chain.map((entry) => entry.stage);

    expect(stages).toEqual(['captured', 'stored', 'redacted', 'transcribed', 'analysed']);
    for (const entry of chain) {
      expect(entry.actor.length).toBeGreaterThan(0);
      expect(entry.contentHash).toBeTruthy();
    }
  });

  it('REFUSES an update to a custody entry', async () => {
    const recordingId = await captured();
    const entry = await appendCustody({
      recordingId,
      stage: 'accessed',
      actor: 'person:ada',
      actorKind: 'human',
      detail: 'Listened to the call.',
    });

    // The guarantee that matters. A chain the application could rewrite is a
    // chain whose integrity rests on the application, which is the thing under
    // dispute when somebody claims a recording was tampered with.
    await expect(
      dataService.query('UPDATE call_custody_event SET detail = $2 WHERE id = $1', [
        entry.id,
        'Did not listen to anything.',
      ])
    ).rejects.toThrow(/append-only/);
  });

  it('REFUSES a delete of a custody entry', async () => {
    const recordingId = await captured();
    const entry = await appendCustody({
      recordingId,
      stage: 'accessed',
      actor: 'person:ada',
      detail: 'Listened to the call.',
    });

    await expect(
      dataService.query('DELETE FROM call_custody_event WHERE id = $1', [entry.id])
    ).rejects.toThrow(/append-only/);
  });

  it('links each entry onto its predecessor rather than hashing in isolation', async () => {
    const recordingId = await captured();
    const first = await appendCustody({
      recordingId,
      stage: 'accessed',
      actor: 'person:ada',
      detail: 'read',
      content: { same: true },
    });
    const second = await appendCustody({
      recordingId,
      stage: 'accessed',
      actor: 'person:ada',
      detail: 'read',
      content: { same: true },
    });

    // IDENTICAL input, different hash — which is the property that makes a
    // removed middle entry visible. Hashing each link in isolation would give
    // these two the same value and prove only that each stage happened, not
    // that none was taken out.
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it('reports a recording with NO chain as not intact', async () => {
    // An id with no chain at all. Deliberately a fresh uuid rather than a real
    // recording stripped of its chain, because stripping one is IMPOSSIBLE by
    // design — which is itself the point of the two tests above.
    const verdict = await verifyChain(randomUUID());

    // An empty chain is the WORST case, not the clean one: either the pipeline
    // never ran or every trace of it is gone, and reporting that as a pass is
    // how a gap becomes invisible.
    expect(verdict.intact).toBe(false);
    expect(verdict.links).toBe(0);
  });

  it('verifies a complete chain', async () => {
    const recordingId = await captured();
    await markStored(recordingId, 'blob_test', 'sha256:abc', 'service:test');

    const verdict = await verifyChain(recordingId);

    expect(verdict.intact).toBe(true);
    expect(verdict.links).toBe(2);
  });

  it('keeps the media out of this database entirely', async () => {
    const columns = await dataService.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'call_recording'`,
      []
    );
    const names = columns.map((row) => row.column_name);

    // The strongest possible answer to "are you sure the recording is gone" is
    // that the audio was never here — only the pointer and the hash.
    expect(names).toContain('media_blob_id');
    expect(names).toContain('content_hash');
    expect(names).not.toContain('media');
    expect(names).not.toContain('audio');
    expect(names).not.toContain('transcript');
  });
});
