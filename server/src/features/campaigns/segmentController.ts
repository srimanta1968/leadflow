import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import {
  EXCLUSION_REASONS, SEGMENT_DIMENSIONS, captureSnapshot, preview, requiredPermittedUse,
  saveDefinition, type Candidate, type SegmentCriteria,
} from './segmentService';

export const segmentRoutes: Router = Router();
segmentRoutes.use(authenticate);

const readCandidates = (body: Record<string, unknown>): Candidate[] => {
  const raw = Array.isArray(body.candidates) ? body.candidates : [];
  return raw
    .map((c) => (c ?? {}) as Record<string, unknown>)
    .filter((c) => typeof c.subject_ref === 'string' && c.subject_ref !== '')
    .map((c) => ({
      subjectRef: c.subject_ref as string,
      leadId: typeof c.lead_id === 'string' ? c.lead_id : null,
      originClass: typeof c.origin_class === 'string' ? c.origin_class : null,
      trustState: typeof c.trust_state === 'string' ? c.trust_state : null,
      stage: typeof c.stage === 'string' ? c.stage : null,
    }));
};

/**
 * POST /api/leadflow/segments/preview — the population estimate, with reasons.
 *
 * THE BREAKDOWN IS THE DELIVERABLE, not the count. "412 eligible" tells a
 * marketer nothing they can act on; naming that 60 have no consent, 21 are
 * suppressed and 7 are licensed records whose rights forbid this channel tells
 * them which of those they can fix and which they must never try to.
 */
segmentRoutes.post(
  '/preview',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const purposeKey = typeof body.purpose_key === 'string' ? body.purpose_key.trim() : '';
    const channel = typeof body.channel === 'string' ? body.channel.trim() : '';
    if (purposeKey === '' || channel === '') {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'purpose_key and channel are both required — eligibility is a property of the pair, and a segment with no stated purpose cannot be checked against source rights at all'
      );
    }

    const candidates = readCandidates(body);
    if (candidates.length === 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'candidates must be a non-empty array of { subject_ref }');
    }

    const criteria = (body.criteria ?? {}) as SegmentCriteria;
    const result = await preview({ candidates, purposeKey, channel, criteria });

    res.status(200).json({
      success: true,
      data: {
        purpose_key: purposeKey, channel,
        considered: candidates.length,
        /* AC2 — eligible versus excluded, with the reason on every refusal. */
        eligible_count: result.eligible.length,
        excluded_count: result.exclusions.length,
        eligible: result.eligible,
        exclusions: result.exclusions,
        breakdown: result.breakdown,
        exclusion_reasons: EXCLUSION_REASONS,
        dimensions: SEGMENT_DIMENSIONS,
        /* AC1 — the rights check, reported explicitly so an outage is visible
           rather than looking like a permissive result. */
        required_permitted_use: requiredPermittedUse(purposeKey, channel),
        licensed_records_checked: result.rightsChecked,
        source_rights_available: !result.rightsUnavailable,
        undecided: result.undecided,
        guarantee: 'A licensed record whose permitted uses exclude this purpose on this channel cannot enter the audience. An unreachable rights service holds the record out rather than admitting it — unknown rights are not permissive rights.',
      },
    });
  })
);

/**
 * POST /api/leadflow/segments — save a versioned definition.
 *
 * A DEFINITION IS IMMUTABLE ONCE WRITTEN. An edit supersedes and writes a new
 * version rather than updating in place, because an audience computed last week
 * must stay explainable against the definition that produced it — an in-place
 * update silently rewrites the reason every past snapshot exists.
 */
segmentRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const segmentKey = typeof body.segment_key === 'string' ? body.segment_key.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const purposeKey = typeof body.purpose_key === 'string' ? body.purpose_key.trim() : '';
    const channel = typeof body.channel === 'string' ? body.channel.trim() : '';

    if (segmentKey === '' || name === '' || purposeKey === '' || channel === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'segment_key, name, purpose_key and channel are all required');
    }
    if (!['email', 'sms', 'voice', 'in_app', 'any'].includes(channel)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'channel must be one of email, sms, voice, in_app, any');
    }

    const saved = await saveDefinition({
      segmentKey, name, purposeKey, channel,
      criteria: (body.criteria ?? {}) as SegmentCriteria,
      createdBy: req.session?.userId ?? null,
    });

    res.status(201).json({
      success: true,
      data: {
        segment_id: saved.segmentId, segment_key: segmentKey, version: saved.version,
        purpose_key: purposeKey, channel,
        note: 'The purpose and channel are part of the DEFINITION. A segment built for one purpose and reused for another is a new segment, which gets its own eligibility pass — that reuse is how a licensed record enters an audience its rights forbid.',
      },
    });
  })
);

/**
 * POST /api/leadflow/segments/:id/compute — snapshot the audience at run start.
 *
 * CAPTURED AT RUN START, not derived later. A segment recomputed a week after
 * the send returns a different set — people convert, consent lapses, records are
 * suppressed — so "who was in this audience" is only answerable if it was
 * written down at the moment it mattered.
 */
segmentRoutes.post(
  '/:id/compute',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const segmentId = String(req.params?.id ?? '');
    const rows = await dataService.query<{
      segment_id: string; segment_key: string; version: number;
      purpose_key: string; channel: string; criteria: SegmentCriteria; superseded_at: string | null;
    }>(
      `SELECT segment_id, segment_key, version, purpose_key, channel, criteria, superseded_at
         FROM leadflow_segment_definition WHERE segment_id = $1`,
      [segmentId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No segment definition with that id');
    const def = rows[0];

    const candidates = readCandidates((req.body ?? {}) as Record<string, unknown>);
    if (candidates.length === 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'candidates must be a non-empty array of { subject_ref }');
    }

    const result = await preview({
      candidates, purposeKey: def.purpose_key, channel: def.channel, criteria: def.criteria ?? {},
    });
    const snapshotId = await captureSnapshot({
      segmentId: def.segment_id, segmentKey: def.segment_key, version: def.version,
      purposeKey: def.purpose_key, channel: def.channel, result,
      computedBy: req.session?.userId ?? null,
    });

    res.status(201).json({
      success: true,
      data: {
        snapshot_id: snapshotId, segment_id: def.segment_id,
        /* AC4 — the snapshot names the version that produced it, denormalised,
           so a later supersede cannot retroactively change what the audience
           was built from. */
        segment_key: def.segment_key, segment_version: def.version,
        definition_superseded: def.superseded_at !== null,
        purpose_key: def.purpose_key, channel: def.channel,
        eligible_count: result.eligible.length,
        excluded_count: result.exclusions.length,
        breakdown: result.breakdown,
        note: 'The refusals are stored alongside the members. "Who did we message" is answerable from the members alone; "why was this person not messaged" is what a complaint or a rights audit actually asks.',
      },
    });
  })
);

/** GET /api/leadflow/segments/:id/snapshots — the retained audit trail. */
segmentRoutes.get(
  '/:id/snapshots',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const segmentId = String(req.params?.id ?? '');
    const rows = await dataService.query<Record<string, unknown>>(
      `SELECT snapshot_id, segment_key, segment_version, purpose_key, channel,
              captured_at, eligible_count, excluded_count, breakdown
         FROM leadflow_audience_snapshot
        WHERE tenant_id = $1 AND segment_id = $2
        ORDER BY captured_at DESC LIMIT 100`,
      [config.projexCloud.tenantId, segmentId]
    );
    res.status(200).json({
      success: true,
      data: { segment_id: segmentId, snapshots: rows, snapshot_count: rows.length },
    });
  })
);
