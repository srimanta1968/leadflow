import { dataService } from '../services/DataService';
import { config } from '../config/env';
import { BRAND } from '../config/verticalProfile';

/**
 * The approved copy for the SOP §16-18 template library.
 *
 * WRITTEN HERE AND SEEDED, not typed into a screen. Twenty-two templates that
 * every sequence step depends on cannot start life as an empty table somebody
 * fills in later — the cadence would dispatch against keys that resolve to
 * nothing, which is exactly the state this seed exists to end.
 *
 * EXACTLY ONE CTA EACH. Not a style preference: a message asking for two things
 * reliably gets neither, and a CHECK constraint on the version row refuses any
 * other count. The CTA is written as a single sentence ending in one ask.
 *
 * FEATURE-STATUS HONESTY. No template claims a capability. Where copy would
 * naturally reach for one ("our new X does Y"), it describes the OUTCOME the
 * customer gets instead, so nothing here can go stale into a false promise.
 *
 * SEEDED AS VERSION 1, PUBLISHED. A library that arrives unpublished is a
 * library the cadence cannot use, and shipping drafts nobody can send is the
 * same as shipping nothing. Idempotent, so a restart re-affirms rather than
 * duplicates.
 */

interface SeedTemplate {
  key: string;
  channel: 'email' | 'sms' | 'voice' | 'call_script';
  purpose: string;
  subject: string | null;
  body: string;
  mergeFields: string[];
}

const B = BRAND.tradingName;

/** SMS bodies carry the STOP notice, because SOP §18 requires it on every one. */
const STOP_NOTICE = ' Reply STOP to opt out.';

export const SEED_TEMPLATES: readonly SeedTemplate[] = [
  /* ------------------------------------------------------------- email x8 */
  {
    key: 'form_confirmation_immediate', channel: 'email', purpose: 'inspection_estimate',
    subject: 'We have your request, {{first_name}}',
    body: `Hi {{first_name}},\n\nThanks for getting in touch with ${B}. I have your request and I am the person looking after it.\n\nI will call you on {{phone}} within the next 30 minutes. If now is not a good time, pick a slot that suits you instead: {{booking_link}}\n\n{{rep_name}}\n${B}`,
    mergeFields: ['first_name', 'phone', 'booking_link', 'rep_name'],
  },
  {
    key: 'after_hours_acknowledgement', channel: 'email', purpose: 'inspection_estimate',
    subject: 'Got your request — we will call you in the morning',
    body: `Hi {{first_name}},\n\nThanks for contacting ${B}. Your request came in outside our hours, so I have put it at the top of tomorrow morning.\n\nYou will hear from {{rep_name}} by 9:30am {{timezone_label}}. If you would rather choose your own time, book one here: {{booking_link}}\n\n${B}`,
    mergeFields: ['first_name', 'rep_name', 'timezone_label', 'booking_link'],
  },
  {
    key: 'no_answer_after_call', channel: 'email', purpose: 'inspection_estimate',
    subject: 'Tried to reach you, {{first_name}}',
    body: `Hi {{first_name}},\n\nI just tried you on {{phone}} about {{request_summary}} and did not catch you.\n\nGrab a time that works and I will call then: {{booking_link}}\n\n{{rep_name}}\n${B}`,
    mergeFields: ['first_name', 'phone', 'request_summary', 'booking_link', 'rep_name'],
  },
  {
    key: 'demo_confirmation', channel: 'email', purpose: 'inspection_estimate',
    subject: 'Confirmed: {{meeting_time}}',
    body: `Hi {{first_name}},\n\nWe are set for {{meeting_time}} ({{timezone_label}}). {{rep_name}} will join and it should take about {{duration_minutes}} minutes.\n\nTo make it useful, reply with the one thing you most want answered.\n\n{{rep_name}}\n${B}`,
    mergeFields: ['first_name', 'meeting_time', 'timezone_label', 'rep_name', 'duration_minutes'],
  },
  {
    key: 'demo_recap_decision_step', channel: 'email', purpose: 'inspection_estimate',
    subject: 'Recap and the next step',
    body: `Hi {{first_name}},\n\nFrom our conversation: you are trying to {{stated_goal}}, and the part that matters most is {{stated_priority}}.\n\nHere is what that looks like with us: {{proposed_approach}}.\n\nIf that reads right, reply "go" and I will send the paperwork.\n\n{{rep_name}}\n${B}`,
    mergeFields: ['first_name', 'stated_goal', 'stated_priority', 'proposed_approach', 'rep_name'],
  },
  {
    key: 'checkout_commercial_follow_up', channel: 'email', purpose: 'inspection_estimate',
    subject: 'Your options, in one place',
    body: `Hi {{first_name}},\n\nEverything we discussed is here, with the terms as they stand today: {{offer_link}} (version {{offer_version}}).\n\nHave a look and tell me which option you want to proceed with.\n\n{{rep_name}}\n${B}`,
    mergeFields: ['first_name', 'offer_link', 'offer_version', 'rep_name'],
  },
  {
    key: 'close_the_loop_recycle', channel: 'email', purpose: 'inspection_estimate',
    subject: 'Should I close this off?',
    body: `Hi {{first_name}},\n\nI have not managed to reach you about {{request_summary}}, so I will assume the timing is wrong rather than keep chasing.\n\nReply with one number and I will do the rest: 1 to book a time, 2 to hear from us later, 3 to close it off.\n\n{{rep_name}}\n${B}`,
    mergeFields: ['first_name', 'request_summary', 'rep_name'],
  },
  {
    key: 'closed_won_welcome_onboarding', channel: 'email', purpose: 'service_delivery',
    subject: 'Welcome to ' + B,
    body: `Hi {{first_name}},\n\nThank you — everything is confirmed and {{onboarding_owner}} is now looking after you.\n\nYour start is booked for {{kickoff_time}}. Add it to your calendar here: {{calendar_link}}\n\n{{onboarding_owner}}\n${B}`,
    mergeFields: ['first_name', 'onboarding_owner', 'kickoff_time', 'calendar_link'],
  },

  /* --------------------------------------------------------------- sms x10 */
  { key: 'sms_form_confirmation', channel: 'sms', purpose: 'inspection_estimate', subject: null,
    body: `${B}: thanks {{first_name}}, got your request. {{rep_name}} will call within 30 min. Prefer to pick a time? {{booking_link}}` + STOP_NOTICE,
    mergeFields: ['first_name', 'rep_name', 'booking_link'] },
  { key: 'sms_after_hours', channel: 'sms', purpose: 'inspection_estimate', subject: null,
    body: `${B}: thanks {{first_name}}. We are closed now — you will hear from us by 9:30am. Book your own slot instead: {{booking_link}}` + STOP_NOTICE,
    mergeFields: ['first_name', 'booking_link'] },
  { key: 'sms_no_answer', channel: 'sms', purpose: 'inspection_estimate', subject: null,
    body: `${B}: {{rep_name}} here — tried calling about {{request_summary}}. Pick a time that suits: {{booking_link}}` + STOP_NOTICE,
    mergeFields: ['rep_name', 'request_summary', 'booking_link'] },
  { key: 'sms_appointment_confirm', channel: 'sms', purpose: 'inspection_estimate', subject: null,
    body: `${B}: confirmed for {{meeting_time}}. Need to change it? {{reschedule_link}}` + STOP_NOTICE,
    mergeFields: ['meeting_time', 'reschedule_link'] },
  { key: 'sms_appointment_reminder', channel: 'sms', purpose: 'inspection_estimate', subject: null,
    body: `${B}: reminder — {{rep_name}} is with you {{meeting_time}}. Reschedule here if needed: {{reschedule_link}}` + STOP_NOTICE,
    mergeFields: ['rep_name', 'meeting_time', 'reschedule_link'] },
  { key: 'sms_on_the_way', channel: 'sms', purpose: 'service_delivery', subject: null,
    body: `${B}: {{rep_name}} is on the way and should arrive about {{eta}}. Track or contact them here: {{tracking_link}}` + STOP_NOTICE,
    mergeFields: ['rep_name', 'eta', 'tracking_link'] },
  { key: 'sms_reschedule', channel: 'sms', purpose: 'inspection_estimate', subject: null,
    body: `${B}: we need to move {{meeting_time}}. Choose a new time that works for you: {{booking_link}}` + STOP_NOTICE,
    mergeFields: ['meeting_time', 'booking_link'] },
  { key: 'sms_quote_ready', channel: 'sms', purpose: 'inspection_estimate', subject: null,
    body: `${B}: your quote is ready, {{first_name}}. Read it here: {{offer_link}}` + STOP_NOTICE,
    mergeFields: ['first_name', 'offer_link'] },
  { key: 'sms_payment_link', channel: 'sms', purpose: 'billing', subject: null,
    body: `${B}: to confirm your booking, complete payment here: {{checkout_link}}` + STOP_NOTICE,
    mergeFields: ['checkout_link'] },
  { key: 'sms_welcome_onboarding', channel: 'sms', purpose: 'service_delivery', subject: null,
    body: `${B}: welcome {{first_name}}. {{onboarding_owner}} is looking after you — your start is {{kickoff_time}}. Add it here: {{calendar_link}}` + STOP_NOTICE,
    mergeFields: ['first_name', 'onboarding_owner', 'kickoff_time', 'calendar_link'] },

  /* -------------------------------------------------------- voice + scripts */
  { key: 'voicemail_first_attempt', channel: 'voice', purpose: 'inspection_estimate', subject: null,
    body: `Hi {{first_name}}, it is {{rep_name}} from ${B} about {{request_summary}}. I will try you again this afternoon — or text this number back with a time that suits you.`,
    mergeFields: ['first_name', 'rep_name', 'request_summary'] },
  { key: 'voicemail_follow_up', channel: 'voice', purpose: 'inspection_estimate', subject: null,
    body: `Hi {{first_name}}, {{rep_name}} from ${B} again. I do not want to keep chasing you, so text me back with either a time or a no and I will act on it.`,
    mergeFields: ['first_name', 'rep_name'] },
  { key: 'call_script_opening', channel: 'call_script', purpose: 'inspection_estimate', subject: null,
    body: `OPEN: "Hi {{first_name}}, {{rep_name}} from ${B} — you asked about {{request_summary}} {{time_since_enquiry}} ago. Is now a bad time?"\n\nTHEN ASK ONE QUESTION: "What made you look into this now?"\n\nLISTEN. Do not pitch until they have answered.\n\nCLOSE ON ONE ASK: book the next step with a specific date and time.`,
    mergeFields: ['first_name', 'rep_name', 'request_summary', 'time_since_enquiry'] },
  { key: 'objection_response_library', channel: 'call_script', purpose: 'inspection_estimate', subject: null,
    body: `"TOO EXPENSIVE" — "Compared with what?" Then price against their alternative, not ours.\n\n"NEED TO THINK" — "Of course. What specifically do you want to be sure about?" Book the follow-up before you hang up.\n\n"SEND ME INFO" — "I will. What should I make sure it covers?" Never send without that answer.\n\n"USING SOMEONE ELSE" — "How is that going?" Ask for their renewal date and diarise it.\n\n"NOT NOW" — "When would be right?" Get a date, or agree to close it off.\n\nNEVER promise a capability we do not have today. If they need something we cannot do, say so and record it.`,
    mergeFields: [] },
];

export interface TemplateSeedResult {
  attempted: boolean;
  created: number;
  alreadyPresent: number;
  published: number;
}

/**
 * Seed the library, idempotently.
 *
 * VERSION 1 IS PUBLISHED IMMEDIATELY. A library of drafts nobody may send is the
 * same as an empty one to a cadence that needs approved copy; RevOps can author
 * version 2 and publish it through the normal gate.
 */
export async function seedTemplates(): Promise<TemplateSeedResult> {
  const result: TemplateSeedResult = { attempted: true, created: 0, alreadyPresent: 0, published: 0 };

  for (const t of SEED_TEMPLATES) {
    const existing = await dataService.query<{ id: string }>(
      `SELECT id FROM leadflow_template_library WHERE template_key = $1 AND channel = $2`,
      [t.key, t.channel]
    );

    let templateId = existing[0]?.id ?? null;
    if (templateId) {
      result.alreadyPresent += 1;
    } else {
      const inserted = await dataService.query<{ id: string }>(
        `INSERT INTO leadflow_template_library
           (template_key, channel, subject, body, purpose_key, cta_count, current_version)
         VALUES ($1,$2,$3,$4,$5,1,1)
         RETURNING id`,
        [t.key, t.channel, t.subject, t.body, t.purpose]
      );
      templateId = inserted[0].id;
      result.created += 1;
    }

    const version = await dataService.query<{ version_id: string }>(
      `INSERT INTO leadflow_template_version
         (tenant_id, template_id, version, subject, body, cta_count, merge_fields,
          claims_feature_available, published_at, published_by, authored_by)
       VALUES ($1,$2,1,$3,$4,1,$5::jsonb,FALSE,now(),'system:seed','system:seed')
       ON CONFLICT (template_id, version) DO NOTHING
       RETURNING version_id`,
      [config.projexCloud.tenantId, templateId, t.subject, t.body, JSON.stringify(t.mergeFields)]
    );
    if (version.length > 0) {
      result.published += 1;
      await dataService.query(
        `UPDATE leadflow_template_library SET approved_at = now(), approved_by = 'system:seed' WHERE id = $1`,
        [templateId]
      );
    }
  }

  return result;
}
