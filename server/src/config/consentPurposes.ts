/**
 * The six LeadFlow consent purposes — the only lawful bases this app records
 * data under.
 *
 * A CLOSED SET for the same reason as the audit vocabulary: a purpose typed
 * freehand at the point of capture cannot be honoured later. A revocation says
 * "stop contacting me about X", and answering it requires X to have been the
 * same string every time it was recorded.
 *
 * Purposes are SEPARATE, never bundled. Consent to hear about an appointment is
 * not consent to receive a seasonal promotion, and a single "marketing" purpose
 * covering both is how an operator ends up sending something the person never
 * agreed to while believing they had a receipt for it.
 */

export interface ConsentPurpose {
  /** Stable key. Recorded on every receipt, so it must never change. */
  key: string;
  /** What the person is shown when asked. */
  label: string;
  /** Why this purpose exists, in the operator's terms. */
  description: string;
  /**
   * True when the purpose is necessary to deliver something the person asked
   * for, rather than something we want to send them. Necessary purposes are
   * still recorded and still revocable — the flag drives DEFAULTS and the order
   * they are presented in, never whether a receipt is required.
   */
  serviceNecessary: boolean;
}

export const CONSENT_PURPOSES: ConsentPurpose[] = [
  {
    key: 'inspection_estimate',
    label: 'Inspection & Estimate',
    description: 'Arranging a site visit and returning a written estimate.',
    serviceNecessary: true,
  },
  {
    key: 'appointment_updates',
    label: 'Appointment Updates',
    description: 'Confirmations, reminders and changes to a booked appointment.',
    serviceNecessary: true,
  },
  {
    key: 'project_operations',
    label: 'Project Operations',
    description: 'Scheduling, access, progress and completion of work in flight.',
    serviceNecessary: true,
  },
  {
    key: 'claim_assistance',
    label: 'Claim Assistance',
    description: 'Helping with an insurance claim related to the work.',
    serviceNecessary: true,
  },
  {
    key: 'seasonal_promotions',
    label: 'Seasonal Promotions',
    description: 'Offers and campaigns unrelated to any work in progress.',
    // The one purely elective purpose. It must never be pre-ticked and must
    // never be inferred from any of the others — someone who asked for an
    // estimate has not asked for marketing.
    serviceNecessary: false,
  },
  {
    key: 'referral_program',
    label: 'Referral Program',
    description: 'Inviting a past customer to refer others, and rewarding it.',
    serviceNecessary: false,
  },
];

/** Look up one purpose by key. */
export function purposeByKey(key: string): ConsentPurpose | undefined {
  return CONSENT_PURPOSES.find((purpose) => purpose.key === key);
}

/** Whether a string names a registered purpose. */
export function isKnownPurpose(key: string): boolean {
  return CONSENT_PURPOSES.some((purpose) => purpose.key === key);
}

/** Purposes that may be defaulted on, because the person asked for the service. */
export function serviceNecessaryPurposes(): ConsentPurpose[] {
  return CONSENT_PURPOSES.filter((purpose) => purpose.serviceNecessary);
}
