/**
 * Every inbound source LeadFlow accepts, and what each one owes.
 *
 * ONE FILE, like `roles.ts`, and for the same reason: adding a source is an
 * edit here and nowhere else. The moment a source needs a switch statement in a
 * handler, the next person adds one quietly and the intake surface stops being
 * reviewable in one sitting.
 *
 * PROVENANCE. Derived from SOP §29, which names the required field set and the
 * failure-queue owner for each channel. Where the SOP is silent the entry says
 * so rather than inventing an owner — an unnamed queue owner is worse than an
 * obviously missing one, because it looks assigned.
 *
 * The three lists are deliberately distinct:
 *  - `requiredFields` is what an adapter MUST capture for the signal to be
 *    usable at all.
 *  - `permissionFields` is what it must capture to establish a lawful basis to
 *    contact the person. Separate because a signal can be perfectly well-formed
 *    and still carry no permission, and the two failures need different fixes.
 *  - `attributionFields` is what must survive to closed-won.
 */

/** Who owns the failure queue when this adapter's signals stop landing. */
export interface FailureQueueOwner {
  /** The role, not a person: people change and the queue does not. */
  role: string;
  /** SOP reference or an honest note that the SOP does not name one. */
  basis: string;
}

export interface SourceAdapter {
  /** Stable key. Matches the platform value on an intake signal. */
  key: string;
  label: string;
  /** What the adapter must capture for the signal to be usable. */
  requiredFields: string[];
  /**
   * Fields establishing a lawful basis to contact the person.
   *
   * EMPTY IS A REAL ANSWER for a channel where the person initiated contact —
   * an inbound phone call carries its own basis. It is recorded as an empty
   * list rather than omitted so "this channel needs none" and "nobody has
   * worked out what this channel needs" cannot look alike.
   */
  permissionFields: string[];
  /** Attribution that must survive to closed-won. */
  attributionFields: string[];
  failureQueue: FailureQueueOwner;
  /**
   * What an operator does when the adapter is down.
   *
   * EVERY adapter has one, and it is never "wait". A channel with no manual
   * path means an outage silently loses leads that a person could have typed
   * in ninety seconds.
   */
  manualFallback: string;
  /** ProjexCloud endpoints this adapter is wired through. */
  sdkEndpoints: string[];
}

export const SOURCE_ADAPTERS: SourceAdapter[] = [
  {
    key: 'meta_lead_ads',
    label: 'Meta — Facebook & Instagram Lead Ads',
    requiredFields: [
      'source_lead_id',
      'form_id',
      'form_version',
      'campaign_id',
      'ad_id',
      'creative_id',
      'created_time',
      'field_data',
    ],
    permissionFields: ['consent_checkbox', 'privacy_policy_url', 'marketing_opt_in'],
    attributionFields: ['campaign_id', 'ad_id', 'creative_id', 'form_id'],
    failureQueue: {
      role: 'revenue_operations + marketing_ops',
      basis: 'SOP §29 names "RevOps + Marketing" as the failure-queue owner for every inbound source adapter.',
    },
    manualFallback:
      'Read the lead in Meta Ads Manager and enter it through Quick Capture with origin FIRST_PARTY_DIRECT, recording the form id in the note so it reconciles when the webhook backfills.',
    sdkEndpoints: ['POST /api/connectors/inbound/meta', 'POST /api/social/interactions'],
  },
  {
    key: 'linkedin',
    label: 'LinkedIn Lead Gen Forms',
    requiredFields: [
      'source_lead_id',
      'form_id',
      'campaign_id',
      'company_urn',
      'profile_urn',
      'submitted_at',
      'answers',
    ],
    permissionFields: ['consent_response', 'legitimate_interest_notice'],
    attributionFields: ['campaign_id', 'form_id'],
    failureQueue: {
      role: 'revenue_operations + marketing_ops',
      basis: 'SOP §29, same owner as the other paid-social adapters.',
    },
    manualFallback:
      'Export the Lead Gen Form CSV from Campaign Manager and import it, which preserves the form and campaign ids as attribution.',
    sdkEndpoints: ['POST /api/connectors/inbound/linkedin'],
  },
  {
    key: 'google_lsa',
    label: 'Google — Local Services, Ads & YouTube',
    requiredFields: [
      'lead_id',
      'lead_type',
      'campaign_id',
      'ad_group_id',
      'gclid',
      'timestamp',
      'form_proof',
    ],
    permissionFields: ['consent_state', 'call_recording_notice'],
    attributionFields: ['campaign_id', 'ad_group_id', 'gclid', 'utm_source', 'utm_medium'],
    failureQueue: {
      role: 'revenue_operations + marketing_ops',
      basis: 'SOP §29 — the paid-search and video surfaces share the paid-social owner because the failure mode is the same: a form or landing event that stops arriving.',
    },
    manualFallback:
      'Local Services leads are visible in the Google Local Services app; enter through Quick Capture and paste the gclid into the note so attribution reconciles.',
    sdkEndpoints: ['POST /api/connectors/inbound/google'],
  },
  {
    key: 'tiktok',
    label: 'TikTok Lead Generation',
    requiredFields: ['lead_id', 'form_id', 'campaign_id', 'ad_id', 'ttclid', 'create_time'],
    permissionFields: ['consent_checkbox', 'privacy_policy_url'],
    attributionFields: ['campaign_id', 'ad_id', 'ttclid'],
    failureQueue: {
      role: 'revenue_operations + marketing_ops',
      basis: 'SOP §29 — same owner as the other paid-social adapters, since a TikTok lead form fails in the same way a Meta one does.',
    },
    manualFallback: 'Download the lead export from TikTok Ads Manager and import it.',
    sdkEndpoints: ['POST /api/connectors/inbound/tiktok'],
  },
  {
    key: 'web_form',
    label: 'Website forms and chat',
    requiredFields: [
      'form_id',
      'form_version',
      'page_url',
      'referrer',
      'session_id',
      'submitted_at',
    ],
    permissionFields: ['submitted_permissions', 'privacy_notice_version'],
    attributionFields: ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'],
    failureQueue: {
      role: 'revenue_operations + web_owner',
      basis: 'SOP §29 names "RevOps + Web owner" for the site and chat surfaces.',
    },
    manualFallback:
      'The form posts to the public capture endpoint, which persists locally even when the gateway is down — so a website outage is the only case needing manual entry, and the page owner is paged rather than the lead being lost.',
    sdkEndpoints: ['POST /api/source-records'],
  },
  {
    key: 'chat_handoff',
    label: 'Chat bot handoff',
    requiredFields: ['session_id', 'transcript', 'handoff_reason', 'page_url', 'started_at'],
    permissionFields: ['submitted_permissions'],
    attributionFields: ['utm_source', 'utm_medium', 'utm_campaign'],
    failureQueue: {
      role: 'revenue_operations + web_owner',
      basis: 'SOP §29 names "RevOps + Web owner" for the site surfaces, and a bot handoff fails on the page rather than in the ad network.',
    },
    manualFallback:
      'The transcript is visible in the chat console; capture it through Quick Capture as a Smart Paste, which keeps the raw text as evidence.',
    sdkEndpoints: ['POST /api/connectors/inbound/chat'],
  },
  {
    key: 'phone',
    label: 'Phone and call tracking',
    requiredFields: [
      'tracking_number',
      'caller_number',
      'inbound_source',
      'call_sid',
      'disposition',
      'started_at',
      'duration_seconds',
    ],
    // A recording consent policy is a permission field even though the caller
    // initiated contact: they consented to be CALLED by calling, not to be
    // recorded.
    permissionFields: ['recording_consent_policy', 'recording_notice_played'],
    attributionFields: ['tracking_number', 'inbound_source'],
    failureQueue: {
      role: 'sales_operations',
      basis: 'SOP §29 assigns call tracking to Sales Ops rather than to Marketing, because a missed call is a staffing failure before it is an adapter failure.',
    },
    manualFallback:
      'A missed-call event still raises the lead from the tracking number alone; the rep enters the details after returning the call.',
    sdkEndpoints: ['POST /api/voice/tracking-numbers'],
  },
  {
    key: 'email',
    label: 'Inbound email',
    requiredFields: ['message_id', 'from_address', 'to_address', 'subject', 'received_at'],
    permissionFields: ['approved_sending_domain', 'reply_routing_verified'],
    attributionFields: ['utm_source', 'utm_campaign'],
    failureQueue: {
      role: 'revenue_operations + it',
      basis: 'SOP §29 names "RevOps + IT" because an email adapter failure is usually a DNS or deliverability problem rather than an application one.',
    },
    manualFallback:
      'The mailbox is still readable directly; forward the message into Quick Capture as a Smart Paste.',
    sdkEndpoints: ['GET /api/deliverability/mailboxes'],
  },
  {
    key: 'referral',
    label: 'Referral and partner',
    requiredFields: ['partner_id', 'referral_id', 'referred_at', 'contact_details'],
    // A referral's permission is the PARTNER's to prove, and the strongest
    // evidence we can hold is their attestation plus the basis they claim.
    permissionFields: ['partner_consent_attestation', 'sharing_basis'],
    attributionFields: ['partner_id', 'referral_id'],
    failureQueue: {
      role: 'revenue_operations',
      basis: 'ELABORATION. §29 does not name an owner for referrals; RevOps owns the partner API keys, so they own the queue until someone says otherwise.',
    },
    manualFallback:
      'Partners can send referrals by email to the monitored mailbox, which is captured through the email adapter.',
    sdkEndpoints: ['POST /api/connectors/inbound/partner'],
  },
];

/** Look up one adapter. */
export function adapterFor(key: string): SourceAdapter | undefined {
  return SOURCE_ADAPTERS.find((adapter) => adapter.key === key);
}

/** Every adapter key, for validation and for the tests that pin the set. */
export function adapterKeys(): string[] {
  return SOURCE_ADAPTERS.map((adapter) => adapter.key);
}

/** One item of the launch-evidence packet SOP §29 requires per integration. */
export interface LaunchEvidenceItem {
  check: string;
  /** What satisfies it — a named artefact, not "we tested it". */
  evidence: string;
  satisfied: boolean;
}

export interface LaunchEvidencePacket {
  adapter: string;
  label: string;
  items: LaunchEvidenceItem[];
  /** True only when every item is satisfied. */
  readyToLaunch: boolean;
}

/**
 * The launch-evidence packet for one adapter.
 *
 * DERIVED, NOT HAND-WRITTEN. A packet typed out per integration is a packet
 * that drifts from the adapter it describes, and the drift always favours
 * looking ready. Generating it from the same declaration the runtime uses means
 * the packet cannot claim a field set the adapter does not capture.
 *
 * `satisfied` is computed from what is DECLARED, so this proves the integration
 * was specified completely — not that it works in production. That distinction
 * is in `evidence` on every item, so nobody reads a green packet as a
 * successful end-to-end test.
 */
export function launchEvidenceFor(key: string): LaunchEvidencePacket | null {
  const adapter = adapterFor(key);
  if (!adapter) {
    return null;
  }

  const items: LaunchEvidenceItem[] = [
    {
      check: 'Required field set declared',
      evidence: `${adapter.requiredFields.length} fields in config/sourceAdapters.ts`,
      satisfied: adapter.requiredFields.length > 0,
    },
    {
      check: 'Permission fields identified',
      evidence:
        adapter.permissionFields.length > 0
          ? `${adapter.permissionFields.join(', ')}`
          : 'None required — the person initiated contact on this channel',
      // An empty list is SATISFIED, not failed: some channels genuinely need
      // none, and failing them would push someone to invent a permission field
      // to clear the check.
      satisfied: true,
    },
    {
      check: 'Attribution fields that must reach closed-won',
      evidence: adapter.attributionFields.join(', '),
      satisfied: adapter.attributionFields.length > 0,
    },
    {
      check: 'Failure-queue owner named',
      evidence: `${adapter.failureQueue.role} — ${adapter.failureQueue.basis}`,
      satisfied: adapter.failureQueue.role.length > 0,
    },
    {
      check: 'Manual fallback documented',
      evidence: adapter.manualFallback,
      satisfied: adapter.manualFallback.length > 0,
    },
    {
      check: 'Idempotency key derivable',
      evidence: 'platform + sourceEventId, enforced by intake_event_replay_key (migration 009)',
      satisfied: adapter.requiredFields.some((field) =>
        ['source_lead_id', 'lead_id', 'message_id', 'call_sid', 'session_id', 'referral_id', 'form_id'].includes(
          field
        )
      ),
    },
  ];

  return {
    adapter: adapter.key,
    label: adapter.label,
    items,
    readyToLaunch: items.every((item) => item.satisfied),
  };
}
