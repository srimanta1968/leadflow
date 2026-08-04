import { dataService } from '../../services/DataService';

/**
 * Attribution carried from an intake signal onto the lead.
 *
 * Every field is nullable because most leads genuinely have none, and the
 * distinction between "no campaign" and "campaign unknown" has to survive — a
 * default of '' would collapse them in exactly the revenue report this exists
 * to serve.
 */
export interface Attribution {
  platform: string | null;
  campaignId: string | null;
  adId: string | null;
  creativeId: string | null;
  formId: string | null;
  clickId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  sourceEventId: string | null;
}

export const EMPTY_ATTRIBUTION: Attribution = {
  platform: null,
  campaignId: null,
  adId: null,
  creativeId: null,
  formId: null,
  clickId: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  sourceEventId: null,
};

/** First present, non-blank string among several candidate keys. */
function pick(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }
  return null;
}

/**
 * Pull attribution out of a signal, whatever shape the platform used.
 *
 * EVERY PLATFORM NAMES THESE DIFFERENTLY and none of them will change to suit
 * us: Meta says `campaign_id`, Google says `campaignId`, LinkedIn buries it in
 * `campaign`. The alias lists are read in preference order, so the platform's
 * own spelling wins and a generic fallback catches the rest.
 *
 * THE CLICK ID IS ONE FIELD, not one per network. `gclid`, `fbclid`, `ttclid`
 * and `li_fat_id` are the same concept — the identifier the network issued for
 * this click — and a column per network means a migration every time marketing
 * adds a channel. Which network it came from is already `platform`.
 */
export function extractAttribution(
  platform: string,
  sourceEventId: string | null,
  payload: Record<string, unknown>,
  campaign: Record<string, unknown> | null
): Attribution {
  // Campaign block first when present: a platform that sends a structured
  // campaign object is stating it deliberately, whereas the same key at the top
  // of a raw payload may be something else entirely.
  const merged: Record<string, unknown> = { ...(payload ?? {}), ...(campaign ?? {}) };
  const utm = (merged.utm as Record<string, unknown> | undefined) ?? merged;

  return {
    platform: platform || null,
    campaignId: pick(merged, 'campaign_id', 'campaignId', 'campaign'),
    adId: pick(merged, 'ad_id', 'adId', 'ad_group_id', 'adGroupId'),
    creativeId: pick(merged, 'creative_id', 'creativeId'),
    formId: pick(merged, 'form_id', 'formId'),
    clickId: pick(merged, 'gclid', 'fbclid', 'ttclid', 'li_fat_id', 'click_id', 'clickId'),
    utmSource: pick(utm, 'utm_source', 'source'),
    utmMedium: pick(utm, 'utm_medium', 'medium'),
    utmCampaign: pick(utm, 'utm_campaign'),
    utmContent: pick(utm, 'utm_content', 'content'),
    utmTerm: pick(utm, 'utm_term', 'term'),
    sourceEventId: sourceEventId && sourceEventId.length > 0 ? sourceEventId : null,
  };
}

/**
 * Write attribution onto a lead.
 *
 * SEPARATE FROM LEAD CREATION on purpose. A lead arrives by webhook, by hand,
 * by import or off the offline queue, and only some of those carry attribution.
 * Folding these columns into every insert would mean four call sites each
 * remembering eleven fields, and the one that forgets produces a lead that
 * reports as organic forever.
 *
 * @returns the number of rows updated, so a caller can tell a real write from a
 *          silent no-op against a lead id that does not exist.
 */
export async function applyAttribution(
  leadId: string,
  attribution: Attribution
): Promise<number> {
  const rows = await dataService.query<{ id: string }>(
    `UPDATE leads
        SET attribution_platform    = COALESCE($2, attribution_platform),
            attribution_campaign_id = COALESCE($3, attribution_campaign_id),
            attribution_ad_id       = COALESCE($4, attribution_ad_id),
            attribution_creative_id = COALESCE($5, attribution_creative_id),
            attribution_form_id     = COALESCE($6, attribution_form_id),
            attribution_click_id    = COALESCE($7, attribution_click_id),
            utm_source              = COALESCE($8, utm_source),
            utm_medium              = COALESCE($9, utm_medium),
            utm_campaign            = COALESCE($10, utm_campaign),
            utm_content             = COALESCE($11, utm_content),
            utm_term                = COALESCE($12, utm_term),
            source_event_id         = COALESCE($13, source_event_id),
            updated_at              = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id`,
    [
      leadId,
      attribution.platform,
      attribution.campaignId,
      attribution.adId,
      attribution.creativeId,
      attribution.formId,
      attribution.clickId,
      attribution.utmSource,
      attribution.utmMedium,
      attribution.utmCampaign,
      attribution.utmContent,
      attribution.utmTerm,
      attribution.sourceEventId,
    ]
  );
  return rows.length;
}

/**
 * Read attribution back off a lead.
 *
 * The closed-won end of the criterion: whatever this returns after the lead has
 * been routed, responded to and closed is what actually survived. COALESCE on
 * write means a later signal carrying nothing cannot blank an earlier one — a
 * routing update must never erase the campaign that produced the lead, which is
 * the most likely way attribution would be lost in practice.
 */
export async function readAttribution(leadId: string): Promise<Attribution | null> {
  const row = await dataService.queryOne<Record<string, string | null>>(
    `SELECT attribution_platform, attribution_campaign_id, attribution_ad_id,
            attribution_creative_id, attribution_form_id, attribution_click_id,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term,
            source_event_id
       FROM leads WHERE id = $1`,
    [leadId]
  );
  if (!row) {
    return null;
  }
  return {
    platform: row.attribution_platform,
    campaignId: row.attribution_campaign_id,
    adId: row.attribution_ad_id,
    creativeId: row.attribution_creative_id,
    formId: row.attribution_form_id,
    clickId: row.attribution_click_id,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    utmTerm: row.utm_term,
    sourceEventId: row.source_event_id,
  };
}
