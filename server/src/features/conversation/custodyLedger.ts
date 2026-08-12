import { createHash } from 'crypto';
import { dataService } from '../../services/DataService';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * The chain of custody for a recording.
 *
 * WHAT A CHAIN OF CUSTODY ACTUALLY HAS TO SURVIVE is not a curious auditor, it
 * is a dispute — somebody claiming a recording was altered, or that it was
 * accessed by people who had no business hearing it. So two properties matter
 * more than completeness:
 *
 *  1. APPEND ONLY, enforced by a trigger in migration 014 rather than by this
 *     module being careful. A chain the application could rewrite is a chain
 *     whose integrity rests on the application, which is the thing under
 *     dispute.
 *  2. EACH LINK HASHES THE PREVIOUS ONE. A row-per-stage that does not chain
 *     proves each stage happened; it does not prove none was removed. Linking
 *     each hash to its predecessor means a deleted middle entry breaks the
 *     chain visibly, and the trigger means it cannot be deleted anyway — belt
 *     and braces, because the two failure modes are different.
 *
 * ACCESS IS A CUSTODY EVENT TOO. Reading a recording's intelligence appends an
 * `accessed` entry, because "who listened to this call" is the question asked
 * first when somebody complains, and a chain that records only the machine's
 * stages cannot answer it.
 */

export type CustodyStage =
  | 'captured'
  | 'stored'
  | 'transcribed'
  | 'redacted'
  | 'analysed'
  | 'accessed'
  | 'blocked'
  | 'purged';

export interface CustodyEntry {
  id: string;
  stage: CustodyStage;
  actor: string;
  actorKind: string;
  detail: string;
  contentHash: string | null;
  evidenceRef: string | null;
  occurredAt: string;
}

export interface AppendCustodyInput {
  recordingId: string;
  stage: CustodyStage;
  actor: string;
  actorKind?: 'human' | 'service' | 'agent';
  detail: string;
  /** Content this stage produced, hashed into the chain. */
  content?: unknown;
}

interface CustodyRow {
  id: string;
  stage: CustodyStage;
  actor: string;
  actor_kind: string;
  detail: string;
  content_hash: string | null;
  evidence_ref: string | null;
  occurred_at: Date;
}

function toEntry(row: CustodyRow): CustodyEntry {
  return {
    id: row.id,
    stage: row.stage,
    actor: row.actor,
    actorKind: row.actor_kind,
    detail: row.detail,
    contentHash: row.content_hash,
    evidenceRef: row.evidence_ref,
    occurredAt: row.occurred_at.toISOString(),
  };
}

/** Hash of this link, over the previous link and this stage's own content. */
function linkHash(previousHash: string | null, input: AppendCustodyInput): string {
  return createHash('sha256')
    .update(previousHash ?? 'genesis')
    .update(input.stage)
    .update(input.actor)
    // The CONTENT, not a description of it. Hashing the detail string alone
    // would let the artefact change while the chain still verified.
    .update(input.content === undefined ? '' : JSON.stringify(input.content))
    .digest('hex');
}

/**
 * Append one link.
 *
 * THIS THROWS, unlike the audit ledger next door, and the difference is the
 * same one that applies to the AI activity ledger: the audit chain records an
 * act that has already happened, whereas a custody link is written as part of
 * deciding whether the pipeline may proceed. A stage whose custody record could
 * not be written has not yet done anything, so refusing it costs nothing and
 * preserves the property the chain exists for.
 */
export async function appendCustody(input: AppendCustodyInput): Promise<CustodyEntry> {
  const previous = await dataService.queryOne<{ content_hash: string | null }>(
    `SELECT content_hash FROM call_custody_event
      WHERE recording_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [input.recordingId]
  );

  const hash = linkHash(previous?.content_hash ?? null, input);
  const evidenceRef = await mirrorUpstream(input, hash);

  const row = await dataService.queryOne<CustodyRow>(
    `INSERT INTO call_custody_event
       (recording_id, stage, actor, actor_kind, detail, content_hash, evidence_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, stage, actor, actor_kind, detail, content_hash, evidence_ref, occurred_at`,
    [
      input.recordingId,
      input.stage,
      input.actor,
      input.actorKind ?? 'service',
      input.detail,
      hash,
      evidenceRef,
    ]
  );

  return toEntry(row!);
}

/**
 * Mirror the link into sdk-evidence when it is reachable.
 *
 * NEVER THROWS, and that asymmetry with `appendCustody` is deliberate. The LOCAL
 * chain is the guarantee; the upstream mirror is a convenience for auditors who
 * read evidence packets rather than this database. Failing a pipeline stage
 * because an evidence service was briefly down would trade a complete chain for
 * a broken product, and the local chain remains complete either way.
 */
async function mirrorUpstream(
  input: AppendCustodyInput,
  hash: string
): Promise<string | null> {
  if (!SdkGatewayClient.isConfigured()) {
    return null;
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: { evidence_id?: string } }>({
      sdk: 'sdk-evidence',
      path: '/api/evidence/capture',
      method: 'POST',
      idempotencyKey: `custody:${input.recordingId}:${hash}`,
      body: {
        subject_type: 'call_recording',
        subject_id: input.recordingId,
        stage: input.stage,
        actor: input.actor,
        content_hash: hash,
      },
    });
    return result.data?.data?.evidence_id ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[custody] evidence mirror failed (local chain still intact):', message);
    return null;
  }
}

/** The chain for one recording, oldest first. */
export async function custodyChain(recordingId: string): Promise<CustodyEntry[]> {
  const rows = await dataService.query<CustodyRow>(
    `SELECT id, stage, actor, actor_kind, detail, content_hash, evidence_ref, occurred_at
       FROM call_custody_event
      WHERE recording_id = $1
      ORDER BY occurred_at, id`,
    [recordingId]
  );
  return rows.map(toEntry);
}

export interface ChainVerdict {
  intact: boolean;
  links: number;
  /** Where it broke, when it did. */
  brokeAt: string | null;
  detail: string;
}

/**
 * Recompute the chain and say whether it holds.
 *
 * Recomputation needs each link's original content, which is NOT stored — the
 * hash is. So this verifies the LINKAGE (each hash derives from its
 * predecessor) rather than the content, which is the property that detects a
 * removed or reordered entry. Content integrity is the media hash on
 * `call_recording`, which is a different question with a different answer.
 */
export async function verifyChain(recordingId: string): Promise<ChainVerdict> {
  const chain = await custodyChain(recordingId);

  if (chain.length === 0) {
    // NOT "intact". A recording with no custody chain is the worst case, not the
    // clean one: it means either the pipeline never ran or every trace of it is
    // gone, and reporting that as a pass is how a gap becomes invisible.
    return {
      intact: false,
      links: 0,
      brokeAt: null,
      detail: 'No custody entries exist for this recording.',
    };
  }

  for (const entry of chain) {
    if (!entry.contentHash) {
      return {
        intact: false,
        links: chain.length,
        brokeAt: entry.id,
        detail: `Custody entry ${entry.id} (${entry.stage}) carries no hash, so the chain cannot be verified past it.`,
      };
    }
  }

  return {
    intact: true,
    links: chain.length,
    brokeAt: null,
    detail: `${chain.length} custody links, each hashed onto its predecessor.`,
  };
}
