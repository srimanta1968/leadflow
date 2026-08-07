import { randomUUID } from 'crypto';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { currentTenantContext, tenantIdFor } from '../../platform/tenancy/tenantHierarchy';
import { QuickCaptureInput } from './quickCaptureValidator';
import { TrustState } from './inboxQuery';

/** What resolution concluded, when it was asked for at all. */
export interface ResolutionOutcome {
  /** False when `searchAfterCapture` was not set — the caller did not ask. */
  attempted: boolean;
  /**
   * True ONLY for an exact crosswalk hit.
   *
   * A crosswalk is a recorded equivalence — this external id IS that person —
   * so following it is a lookup, not a judgement. Everything else, however
   * confident, is a probability.
   */
  autoLinked: boolean;
  /** The person linked to, when auto-linked. */
  personId: string | null;
  /** Candidate case opened for a human, when the match was ambiguous. */
  candidateCaseRef: string | null;
  /** Plain-language reason, for the operator rather than the developer. */
  explanation: string;
}

export interface QuickCaptureResult {
  sourceRecordId: string;
  trustState: TrustState;
  originClass: string;
  /** Echoed back verbatim so the caller can see what was actually stored. */
  rawInput: string;
  /** False when the gateway is unconfigured and evidence stayed local. */
  evidenceStored: boolean;
  resolution: ResolutionOutcome;
  /** Fields a parser proposed. Never authoritative — see `parseIfAssisted`. */
  proposal: Record<string, unknown> | null;
}

/** One row as sdk-identity-resolver answers. */
interface ResolveResponse {
  data?: {
    match_type?: string;
    person_id?: string;
    case_id?: string;
    confidence?: number;
  };
}

interface SourceRecordResponse {
  data?: { source_record?: { capture_id?: string; trust_state?: string } };
}

interface ParseResponse {
  data?: { contact?: Record<string, unknown> };
}

/**
 * Commit an uploaded image so the evidence blob is durable before it is cited.
 *
 * Ordered FIRST for a reason: the source record names the blob, and naming a
 * blob that was never committed produces evidence that cannot be fetched — a
 * record that looks proven and is not. Non-fatal, because a lost image is worth
 * less than a lost lead: the capture proceeds and the reference is dropped.
 */
async function commitEvidenceBlob(blobRef: string, correlationId: string): Promise<string | null> {
  try {
    await SdkGatewayClient.call({
      sdk: 'sdk-media',
      path: `/api/media/${encodeURIComponent(blobRef)}/ready`,
      method: 'POST',
      idempotencyKey: `media-ready:${blobRef}`,
      correlationId,
      body: { tenant_id: tenantIdFor(currentTenantContext(), 'lead') },
    });
    return blobRef;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[quickCapture] evidence blob could not be committed:', message);
    return null;
  }
}

/**
 * Ask sdk-parsing for contact fields — ONLY when the operator asked for help.
 *
 * ASSISTIVE, NEVER AUTHORITATIVE. The result is a proposal the operator has
 * already reviewed on their screen; it never replaces the raw input and never
 * decides anything. A parse that fails leaves the capture intact with the
 * operator's own fields, which is why this returns null rather than throwing.
 */
async function parseIfAssisted(
  input: QuickCaptureInput,
  correlationId: string
): Promise<Record<string, unknown> | null> {
  if (input.mode !== 'assisted') {
    return input.parsedProposal as Record<string, unknown> | null;
  }

  try {
    const result = await SdkGatewayClient.call<ParseResponse>({
      sdk: 'sdk-parsing',
      path: '/api/parsing/contact/extract',
      method: 'POST',
      correlationId,
      body: {
        tenant_id: tenantIdFor(currentTenantContext(), 'lead'),
        text: input.rawInput,
      },
    });
    return (
      result.data?.data?.contact ?? (input.parsedProposal as Record<string, unknown> | null) ?? null
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[quickCapture] parsing unavailable, keeping the operator proposal:', message);
    return input.parsedProposal as Record<string, unknown> | null;
  }
}

/**
 * Store the raw input as immutable evidence under the declared origin class.
 *
 * `raw_evidence` carries the input EXACTLY as it arrived — untrimmed, unparsed,
 * including whatever the operator typed. That is the whole point: the record is
 * only proof if it was not tidied on the way in, and a later correction has to
 * be checkable against what actually arrived rather than against our reading of
 * it.
 */
async function storeEvidence(
  input: QuickCaptureInput,
  blobRef: string | null,
  proposal: Record<string, unknown> | null,
  correlationId: string,
  captureId: string
): Promise<{ id: string; trustState: TrustState; stored: boolean }> {
  if (!SdkGatewayClient.isConfigured()) {
    // The documented local fallback. The capture still happened and still has an
    // id; `evidenceStored: false` is what tells the caller it lives only here.
    return { id: captureId, trustState: 'P0_CAPTURED', stored: false };
  }

  const result = await SdkGatewayClient.call<SourceRecordResponse>({
    sdk: 'sdk-source-record',
    path: '/api/source-records',
    method: 'POST',
    idempotencyKey: captureId,
    correlationId,
    body: {
      tenant_id: tenantIdFor(currentTenantContext(), 'lead'),
      source_system: 'leadflow',
      source_external_id: captureId,
      origin_class: input.originClass,
      raw_evidence: {
        // Verbatim. Not the proposal, not a normalised copy.
        raw_input: input.rawInput,
        mode: input.mode,
        note: input.note,
        evidence_blob_ref: blobRef,
        // Kept ALONGSIDE the raw input, clearly labelled, so nobody later reads
        // an extraction as though it were what arrived.
        proposed_fields: proposal,
      },
    },
  });

  const record = result.data?.data?.source_record;
  return {
    id: record?.capture_id ?? captureId,
    trustState: (record?.trust_state as TrustState) ?? 'P0_CAPTURED',
    stored: result.delivered,
  };
}

/**
 * Resolve the capture against known people — only when asked, and only
 * auto-linking an exact crosswalk.
 *
 * THE RULE THIS ENFORCES: anything short of an exact crosswalk becomes a
 * P2_CANDIDATE for a human. A probabilistic match, however confident, is a
 * guess about which human this is — and merging two different people is far
 * harder to undo than it was to make, because every downstream record then
 * points at the merged identity. Leaving it for adjudication costs somebody a
 * minute; getting it wrong costs a data-repair project.
 */
async function resolveIfRequested(
  input: QuickCaptureInput,
  sourceRecordId: string,
  correlationId: string
): Promise<ResolutionOutcome> {
  if (!input.searchAfterCapture) {
    return {
      attempted: false,
      autoLinked: false,
      personId: null,
      candidateCaseRef: null,
      explanation: 'No search was requested for this capture.',
    };
  }

  if (!SdkGatewayClient.isConfigured()) {
    return {
      attempted: true,
      autoLinked: false,
      personId: null,
      candidateCaseRef: null,
      explanation: 'Identity resolution is unavailable, so this stays unlinked for review.',
    };
  }

  try {
    const result = await SdkGatewayClient.call<ResolveResponse>({
      sdk: 'sdk-identity-resolver',
      path: '/api/resolver/resolve',
      method: 'POST',
      idempotencyKey: `resolve:${sourceRecordId}`,
      correlationId,
      body: {
        tenant_id: tenantIdFor(currentTenantContext(), 'lead'),
        source_record_id: sourceRecordId,
        traits: input.parsedProposal ?? {},
      },
    });

    const match = result.data?.data;
    // ONLY this one value auto-links. Written as an explicit equality rather
    // than a confidence threshold on purpose: a threshold is a dial someone
    // will eventually turn, and turning it converts adjudication into silent
    // merging without any code review noticing.
    if (match?.match_type === 'exact_crosswalk' && match.person_id) {
      return {
        attempted: true,
        autoLinked: true,
        personId: match.person_id,
        candidateCaseRef: null,
        explanation: 'Linked automatically: a recorded crosswalk already identifies this person.',
      };
    }

    return {
      attempted: true,
      autoLinked: false,
      personId: null,
      candidateCaseRef: match?.case_id ?? null,
      explanation: match?.case_id
        ? 'A possible match was found and needs a human decision before linking.'
        : 'No match was found, so this stays unlinked.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[quickCapture] resolution unavailable:', message);
    // FAILS UNLINKED. An unreachable resolver must never be read as "no match,
    // safe to treat as new" — that is how a duplicate person gets created.
    return {
      attempted: true,
      autoLinked: false,
      personId: null,
      candidateCaseRef: null,
      explanation: 'Identity resolution could not be reached, so this stays unlinked for review.',
    };
  }
}

export class QuickCaptureService {
  /**
   * Capture a lead in one call.
   *
   * ORDER IS THE CONTRACT: commit the blob, parse if asked, store the evidence,
   * then resolve. Evidence is stored BEFORE resolution because resolution
   * references the source record — resolving first would mean linking a record
   * that does not yet exist, and a failure between the two would leave a link
   * pointing at nothing.
   */
  static async capture(input: QuickCaptureInput): Promise<QuickCaptureResult> {
    const correlationId = randomUUID();
    const captureId = randomUUID();

    const blobRef = input.evidenceBlobRef
      ? await commitEvidenceBlob(input.evidenceBlobRef, correlationId)
      : null;

    const proposal = await parseIfAssisted(input, correlationId);

    const stored = await storeEvidence(input, blobRef, proposal, correlationId, captureId);

    const resolution = await resolveIfRequested(input, stored.id, correlationId);

    return {
      sourceRecordId: stored.id,
      // An auto-link moves the record up the ladder; anything else leaves it
      // where the evidence puts it.
      trustState: resolution.autoLinked ? 'P3_LINKED' : stored.trustState,
      originClass: input.originClass,
      rawInput: input.rawInput,
      evidenceStored: stored.stored,
      resolution,
      proposal,
    };
  }
}
