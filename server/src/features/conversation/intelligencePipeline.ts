import { createHash } from 'crypto';
import { dataService } from '../../services/DataService';
import { redact, RedactionHit } from '../../platform/ai/redaction';
import { AppError, ErrorCodes } from '../../utils/errors';
import { appendCustody } from './custodyLedger';
import { checkRecordingEligibility, EligibilityInput } from './recordingEligibility';

/**
 * The conversation intelligence pipeline.
 *
 * Capture under a verified basis, then transcription, diarization, summary,
 * sentiment, objection detection, action items, deal risk and coaching input.
 * Two rules hold across every stage and are worth stating before the code:
 *
 *  1. EVERY DERIVED ARTIFACT CARRIES ITS OFFSET into the source recording, and
 *     the columns are NOT NULL, so an artifact that cannot say where in the call
 *     it came from cannot be stored. A summary that asserts "they raised budget
 *     concerns" without a citation is an opinion; the same summary with
 *     04:12–04:31 on it is a claim somebody can check in eleven seconds.
 *  2. TEXT IS REDACTED BEFORE IT LEAVES THE TENANT for analysis, and the
 *     redaction result is recorded on the artifact. Not "we intend to redact" —
 *     the analysis stages take the redacted text as their input, so unredacted
 *     text has no path to the gateway.
 */

/** A diarized transcript segment as the transcription stage produces it. */
export interface TranscriptSegment {
  speaker: 'rep' | 'prospect' | 'unknown';
  text: string;
  startMs: number;
  endMs: number;
}

export interface DerivedArtifact {
  id: string;
  kind:
    | 'transcript_segment'
    | 'summary'
    | 'sentiment'
    | 'objection'
    | 'action_item'
    | 'deal_risk'
    | 'coaching_input';
  producedBy: string;
  speaker: string | null;
  content: Record<string, unknown>;
  /** Milliseconds from the start of the recording. Never null — see the migration. */
  sourceStartMs: number;
  sourceEndMs: number;
  redactionApplied: RedactionHit[];
  createdAt: string;
}

export interface RecordingRecord {
  id: string;
  callId: string | null;
  externalCallId: string;
  mediaBlobId: string | null;
  consentBasisRef: string;
  jurisdiction: string;
  jurisdictionRule: string;
  durationMs: number | null;
  contentHash: string | null;
  status: string;
  createdAt: string;
}

interface RecordingRow {
  id: string;
  call_id: string | null;
  external_call_id: string;
  media_blob_id: string | null;
  consent_basis_ref: string;
  jurisdiction: string;
  jurisdiction_rule: string;
  duration_ms: number | null;
  content_hash: string | null;
  status: string;
  created_at: Date;
}

function toRecording(row: RecordingRow): RecordingRecord {
  return {
    id: row.id,
    callId: row.call_id,
    externalCallId: row.external_call_id,
    mediaBlobId: row.media_blob_id,
    consentBasisRef: row.consent_basis_ref,
    jurisdiction: row.jurisdiction,
    jurisdictionRule: row.jurisdiction_rule,
    durationMs: row.duration_ms,
    contentHash: row.content_hash,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export interface CaptureInput extends EligibilityInput {
  externalCallId: string;
  callId?: string | null;
  mediaBlobId?: string | null;
  durationMs?: number | null;
  /** Who is recording. Recorded as the first custody actor. */
  actor: string;
}

/**
 * Capture a recording, or refuse with the reason.
 *
 * THE ELIGIBILITY CHECK IS THE FIRST THING THAT HAPPENS and nothing is written
 * before it passes — no recording row, no media pointer, no artifact. A refusal
 * does leave a trace, but on the CALL rather than as a recording: see the
 * `blocked` custody stage, which is written only when a recording row already
 * exists from an earlier attempt. A refusal with no prior recording is reported
 * to the caller and stored nowhere, because storing a row for a recording that
 * was never made is how a table of recordings stops meaning what it says.
 *
 * @throws AppError(422 RECORDING_CONSENT_MISSING) carrying the rep-facing reason.
 */
export async function captureRecording(input: CaptureInput): Promise<RecordingRecord> {
  const eligibility = await checkRecordingEligibility(input);

  if (!eligibility.allowed) {
    throw new AppError(422, ErrorCodes.RECORDING_CONSENT_MISSING, eligibility.reason, {
      blockCode: eligibility.blockCode,
      remedy: eligibility.remedy,
      jurisdiction: eligibility.jurisdiction.code,
      jurisdictionRule: eligibility.jurisdiction.rule,
    });
  }

  const row = await dataService.queryOne<RecordingRow>(
    `INSERT INTO call_recording
       (call_id, external_call_id, media_blob_id, consent_basis_ref, consent_verified_at,
        consent_method, jurisdiction, jurisdiction_rule, duration_ms, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'captured')
     ON CONFLICT (external_call_id) DO UPDATE
       SET media_blob_id = COALESCE(EXCLUDED.media_blob_id, call_recording.media_blob_id),
           duration_ms   = COALESCE(EXCLUDED.duration_ms, call_recording.duration_ms)
     RETURNING id, call_id, external_call_id, media_blob_id, consent_basis_ref,
               jurisdiction, jurisdiction_rule, duration_ms, content_hash, status, created_at`,
    [
      input.callId ?? null,
      input.externalCallId,
      input.mediaBlobId ?? null,
      eligibility.basisRef,
      eligibility.checkedAt,
      eligibility.consentMethod ?? 'local_basis_only',
      eligibility.jurisdiction.code,
      eligibility.jurisdiction.rule,
      input.durationMs ?? null,
      // ON CONFLICT rather than a plain insert: a redelivered Twilio webhook
      // must not create a second recording of the same conversation, which
      // would double every downstream artifact.
    ]
  );

  const recording = toRecording(row!);

  await appendCustody({
    recordingId: recording.id,
    stage: 'captured',
    actor: input.actor,
    actorKind: 'service',
    detail: `Captured under ${eligibility.jurisdiction.code} (${eligibility.jurisdiction.rule}), consent ${eligibility.consentMethod}.`,
    content: {
      basisRef: eligibility.basisRef,
      jurisdiction: eligibility.jurisdiction.code,
      externalCallId: input.externalCallId,
    },
  });

  return recording;
}

/** Record the media landing in sdk-media, with its hash. */
export async function markStored(
  recordingId: string,
  mediaBlobId: string,
  contentHash: string,
  actor: string
): Promise<void> {
  await dataService.query(
    `UPDATE call_recording
        SET media_blob_id = $2, content_hash = $3, status = 'stored'
      WHERE id = $1`,
    [recordingId, mediaBlobId, contentHash]
  );

  await appendCustody({
    recordingId,
    stage: 'stored',
    actor,
    detail: `Media stored as blob ${mediaBlobId}.`,
    // The MEDIA hash goes into the chain, so a later claim that the audio was
    // swapped is checkable rather than arguable.
    content: { mediaBlobId, contentHash },
  });
}

/** One artifact to write, before offsets are validated. */
interface ArtifactDraft {
  kind: DerivedArtifact['kind'];
  producedBy: string;
  speaker?: string | null;
  content: Record<string, unknown>;
  sourceStartMs: number;
  sourceEndMs: number;
  redactionApplied?: RedactionHit[];
}

/** Write one artifact. */
async function writeArtifact(
  recordingId: string,
  draft: ArtifactDraft
): Promise<DerivedArtifact> {
  const row = await dataService.queryOne<{
    id: string;
    kind: DerivedArtifact['kind'];
    produced_by: string;
    speaker: string | null;
    content: Record<string, unknown>;
    source_start_ms: number;
    source_end_ms: number;
    redaction_applied: RedactionHit[];
    created_at: Date;
  }>(
    `INSERT INTO call_artifact
       (recording_id, kind, produced_by, speaker, content, source_start_ms, source_end_ms,
        redaction_applied)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, kind, produced_by, speaker, content, source_start_ms, source_end_ms,
               redaction_applied, created_at`,
    [
      recordingId,
      draft.kind,
      draft.producedBy,
      draft.speaker ?? null,
      JSON.stringify(draft.content),
      draft.sourceStartMs,
      draft.sourceEndMs,
      JSON.stringify(draft.redactionApplied ?? []),
    ]
  );

  return {
    id: row!.id,
    kind: row!.kind,
    producedBy: row!.produced_by,
    speaker: row!.speaker,
    content: row!.content,
    sourceStartMs: row!.source_start_ms,
    sourceEndMs: row!.source_end_ms,
    redactionApplied: row!.redaction_applied,
    createdAt: row!.created_at.toISOString(),
  };
}

/** The span a set of segments covers, for an artifact derived from several. */
function spanOf(segments: TranscriptSegment[]): { startMs: number; endMs: number } {
  return {
    startMs: Math.min(...segments.map((segment) => segment.startMs)),
    endMs: Math.max(...segments.map((segment) => segment.endMs)),
  };
}

/**
 * Objection cues, matched against the redacted text.
 *
 * DELIBERATELY A SMALL CUE LIST, not a classifier. The point of this stage is
 * to say WHERE in the call an objection was raised so a human can listen to it,
 * and a cue that matches the prospect's actual words gives an exact offset. A
 * classifier would give a better recall rate and a worse citation, which is the
 * wrong trade for an artifact whose entire value is traceability.
 */
const OBJECTION_CUES: { key: string; cues: string[] }[] = [
  { key: 'price', cues: ['too expensive', 'out of budget', 'cost too much', 'cheaper'] },
  { key: 'timing', cues: ['not right now', 'next quarter', 'call me back', 'bad time'] },
  { key: 'authority', cues: ['not my decision', 'talk to my', 'run it past'] },
  { key: 'incumbent', cues: ['already use', 'happy with our', 'under contract'] },
  { key: 'trust', cues: ['never heard of', 'send me something', 'not interested'] },
];

/** Words that move the sentiment reading, with the direction they move it. */
const SENTIMENT_CUES: { word: string; weight: number }[] = [
  { word: 'great', weight: 1 },
  { word: 'perfect', weight: 1 },
  { word: 'interested', weight: 1 },
  { word: 'helpful', weight: 1 },
  { word: 'yes', weight: 0.5 },
  { word: 'no', weight: -0.5 },
  { word: 'expensive', weight: -1 },
  { word: 'frustrated', weight: -1 },
  { word: 'confused', weight: -1 },
  { word: 'disappointed', weight: -1 },
];

export interface AnalyseInput {
  recordingId: string;
  segments: TranscriptSegment[];
  actor: string;
}

/**
 * Run transcription through coaching input, writing one artifact per finding.
 *
 * REDACTION HAPPENS ONCE, AT THE TOP, and every downstream stage reads the
 * redacted segments. Redacting per stage would mean each new stage is one
 * forgotten call away from sending raw text, and the stage most likely to
 * forget is the one somebody adds in a hurry.
 */
export async function analyseRecording(input: AnalyseInput): Promise<DerivedArtifact[]> {
  if (input.segments.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'At least one transcript segment is required');
  }

  for (const segment of input.segments) {
    if (segment.endMs < segment.startMs || segment.startMs < 0) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Every segment needs a non-negative startMs and an endMs at or after it'
      );
    }
  }

  // ---- Redaction, before anything is analysed or stored -------------------
  const totals = new Map<string, number>();
  const redacted: TranscriptSegment[] = input.segments.map((segment) => {
    const result = redact(segment.text);
    for (const hit of result.applied) {
      totals.set(hit.rule, (totals.get(hit.rule) ?? 0) + hit.count);
    }
    return { ...segment, text: result.text };
  });
  const redactionApplied: RedactionHit[] = [...totals.entries()].map(([rule, count]) => ({
    rule,
    count,
  }));

  await appendCustody({
    recordingId: input.recordingId,
    stage: 'redacted',
    actor: input.actor,
    detail: `Redaction applied to ${redacted.length} segments; ${redactionApplied.reduce((total, hit) => total + hit.count, 0)} spans removed.`,
    // COUNTS in the chain, never the removed values.
    content: { redactionApplied, segmentCount: redacted.length },
  });

  const artifacts: DerivedArtifact[] = [];

  // ---- Transcript segments -----------------------------------------------
  for (const segment of redacted) {
    artifacts.push(
      await writeArtifact(input.recordingId, {
        kind: 'transcript_segment',
        producedBy: 'transcription+diarization',
        speaker: segment.speaker,
        content: { text: segment.text },
        sourceStartMs: segment.startMs,
        sourceEndMs: segment.endMs,
        redactionApplied,
      })
    );
  }

  await appendCustody({
    recordingId: input.recordingId,
    stage: 'transcribed',
    actor: input.actor,
    detail: `${redacted.length} diarized segments written.`,
    content: { segmentCount: redacted.length, span: spanOf(redacted) },
  });

  // ---- Objections ---------------------------------------------------------
  for (const segment of redacted) {
    const lower = segment.text.toLowerCase();
    for (const family of OBJECTION_CUES) {
      const cue = family.cues.find((candidate) => lower.includes(candidate));
      if (!cue) {
        continue;
      }
      artifacts.push(
        await writeArtifact(input.recordingId, {
          kind: 'objection',
          producedBy: 'objection_detection',
          speaker: segment.speaker,
          // The CUE is recorded, not just the family: a rep disputing the
          // reading can see exactly which words triggered it.
          content: { family: family.key, cue },
          sourceStartMs: segment.startMs,
          sourceEndMs: segment.endMs,
          redactionApplied,
        })
      );
    }
  }

  // ---- Action items -------------------------------------------------------
  for (const segment of redacted) {
    const lower = segment.text.toLowerCase();
    if (lower.includes('i will') || lower.includes("i'll") || lower.includes('send you')) {
      artifacts.push(
        await writeArtifact(input.recordingId, {
          kind: 'action_item',
          producedBy: 'action_item_extraction',
          speaker: segment.speaker,
          content: { commitment: segment.text },
          sourceStartMs: segment.startMs,
          sourceEndMs: segment.endMs,
          redactionApplied,
        })
      );
    }
  }

  // ---- Sentiment ----------------------------------------------------------
  const prospect = redacted.filter((segment) => segment.speaker === 'prospect');
  const sentimentSource = prospect.length > 0 ? prospect : redacted;
  let score = 0;
  for (const segment of sentimentSource) {
    const lower = segment.text.toLowerCase();
    for (const cue of SENTIMENT_CUES) {
      if (lower.includes(cue.word)) {
        score += cue.weight;
      }
    }
  }
  const sentimentSpan = spanOf(sentimentSource);
  artifacts.push(
    await writeArtifact(input.recordingId, {
      kind: 'sentiment',
      producedBy: 'sentiment',
      // Whose sentiment, said explicitly. A single unattributed number invites
      // a manager to read the rep's enthusiasm as the prospect's.
      speaker: prospect.length > 0 ? 'prospect' : 'unknown',
      content: {
        score: Number(score.toFixed(2)),
        reading: score > 0.5 ? 'positive' : score < -0.5 ? 'negative' : 'neutral',
        basis: prospect.length > 0 ? 'prospect turns only' : 'all turns — no prospect turns were diarized',
      },
      sourceStartMs: sentimentSpan.startMs,
      sourceEndMs: sentimentSpan.endMs,
      redactionApplied,
    })
  );

  // ---- Summary ------------------------------------------------------------
  const fullSpan = spanOf(redacted);
  artifacts.push(
    await writeArtifact(input.recordingId, {
      kind: 'summary',
      producedBy: 'summary',
      content: {
        text: `Call of ${Math.round((fullSpan.endMs - fullSpan.startMs) / 1000)}s across ${redacted.length} turns.`,
        objectionCount: artifacts.filter((artifact) => artifact.kind === 'objection').length,
        actionItemCount: artifacts.filter((artifact) => artifact.kind === 'action_item').length,
      },
      // The WHOLE call, which is the honest span for a summary. Citing the first
      // segment would make it look like a claim about one moment.
      sourceStartMs: fullSpan.startMs,
      sourceEndMs: fullSpan.endMs,
      redactionApplied,
    })
  );

  // ---- Deal risk ----------------------------------------------------------
  const objections = artifacts.filter((artifact) => artifact.kind === 'objection');
  const actionItems = artifacts.filter((artifact) => artifact.kind === 'action_item');
  const risk = Math.min(1, objections.length * 0.25 + (actionItems.length === 0 ? 0.3 : 0));
  artifacts.push(
    await writeArtifact(input.recordingId, {
      kind: 'deal_risk',
      producedBy: 'deal_risk',
      content: {
        risk: Number(risk.toFixed(2)),
        // The artifacts it was computed from, by id, so the signal is walkable
        // back to the moments rather than only to a number.
        derivedFrom: [...objections, ...actionItems].map((artifact) => artifact.id),
        because:
          actionItems.length === 0
            ? 'Nobody committed to anything on this call, which is the strongest single predictor of a stalled deal.'
            : `${objections.length} objection(s) raised, with commitments made.`,
      },
      sourceStartMs: fullSpan.startMs,
      sourceEndMs: fullSpan.endMs,
      redactionApplied,
    })
  );

  // ---- Coaching input -----------------------------------------------------
  artifacts.push(
    await writeArtifact(input.recordingId, {
      kind: 'coaching_input',
      producedBy: 'coaching_input',
      content: {
        objectionFamilies: [...new Set(objections.map((artifact) => artifact.content.family))],
        commitmentsMade: actionItems.length,
        note: 'Feeds the Sales Coach scorecard; not a scorecard itself.',
      },
      sourceStartMs: fullSpan.startMs,
      sourceEndMs: fullSpan.endMs,
      redactionApplied,
    })
  );

  await dataService.query("UPDATE call_recording SET status = 'analysed' WHERE id = $1", [
    input.recordingId,
  ]);

  await appendCustody({
    recordingId: input.recordingId,
    stage: 'analysed',
    actor: input.actor,
    detail: `${artifacts.length} artifacts derived, every one carrying its source offset.`,
    content: {
      artifactCount: artifacts.length,
      // Hash over the artifact ids and spans: a later claim that an artifact was
      // added or its citation moved is checkable against this.
      artifactDigest: createHash('sha256')
        .update(artifacts.map((a) => `${a.id}:${a.sourceStartMs}-${a.sourceEndMs}`).join('|'))
        .digest('hex'),
    },
  });

  return artifacts;
}

/** One recording by the call it belongs to. */
export async function recordingForCall(callId: string): Promise<RecordingRecord | null> {
  const row = await dataService.queryOne<RecordingRow>(
    `SELECT id, call_id, external_call_id, media_blob_id, consent_basis_ref,
            jurisdiction, jurisdiction_rule, duration_ms, content_hash, status, created_at
       FROM call_recording
      WHERE call_id = $1 OR id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [callId]
  );
  return row ? toRecording(row) : null;
}

/** Artifacts for a recording, in call order. */
export async function artifactsFor(recordingId: string): Promise<DerivedArtifact[]> {
  const rows = await dataService.query<{
    id: string;
    kind: DerivedArtifact['kind'];
    produced_by: string;
    speaker: string | null;
    content: Record<string, unknown>;
    source_start_ms: number;
    source_end_ms: number;
    redaction_applied: RedactionHit[];
    created_at: Date;
  }>(
    `SELECT id, kind, produced_by, speaker, content, source_start_ms, source_end_ms,
            redaction_applied, created_at
       FROM call_artifact
      WHERE recording_id = $1
      ORDER BY source_start_ms, kind`,
    [recordingId]
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    producedBy: row.produced_by,
    speaker: row.speaker,
    content: row.content,
    sourceStartMs: row.source_start_ms,
    sourceEndMs: row.source_end_ms,
    redactionApplied: row.redaction_applied,
    createdAt: row.created_at.toISOString(),
  }));
}
