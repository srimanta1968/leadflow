import type { DelimiterValue, EncodingChoice } from './csvPreview';

/**
 * Import wizard state that survives a reload.
 *
 * TEN STEPS IS A LONG WAY TO LOSE. The wizard asks for a source, a connector
 * configuration, an origin attestation, a column mapping, a transform plan, an
 * identity strategy, access, consent and finally a commit. Dropping all of that
 * because a laptop slept or a tab was refreshed means the operator starts again
 * from step one, and the predictable response is to rush the attestation the
 * second time.
 *
 * WHAT IS DELIBERATELY *NOT* PERSISTED IS THE POINT OF THIS FILE.
 *
 *  - No credential, ever. The wizard collects a credential REFERENCE — a name
 *    that resolves in sdk-secrets — and never the secret itself, so there is
 *    nothing here for a shared or stolen machine to yield. `sanitise()` strips
 *    anything secret-shaped even if a future field slips through.
 *  - No file contents. The preview is computed locally from a slice of the
 *    file; writing those bytes into storage would put an unattested contact
 *    export into the browser's disk cache, which is precisely what deferring
 *    the upload until after the attestation exists to avoid.
 *
 * sessionStorage rather than localStorage: a reload keeps the draft, closing
 * the tab discards it. An import draft is a task in progress, not a document,
 * and a half-finished attestation should not outlive the session that made it.
 */

export const WIZARD_STORAGE_KEY = 'leadflow.import.wizard.v1';

export interface WizardState {
  /** 1-10. The stepper's position. */
  step: number;
  /** Connector kind from the source grid, e.g. 'custom' | 'google'. */
  source: string | null;
  delimiter: DelimiterValue | null;
  encoding: EncodingChoice;
  headerRow: 'First row' | 'No header';
  connectorMode: 'Approved API' | 'Source-native export';
  /**
   * The NAME of a vault-backed credential, never the credential.
   *
   * sdk-secrets resolves this server-side at commit. If this string leaked it
   * would tell an attacker that a secret called "acculynx-prod" exists and
   * nothing else — which is the entire design.
   */
  credentialReference: string;
  location: string;
  /**
   * The chosen file's NAME only, so the wizard can say "you picked
   * contacts.csv" after a reload. The bytes are gone and the operator is asked
   * to choose it again — stating that plainly beats silently pretending the
   * file is still attached.
   */
  fileName: string | null;
}

export const EMPTY_WIZARD_STATE: WizardState = {
  step: 1,
  source: 'custom',
  delimiter: null,
  encoding: 'Auto-detect UTF-8',
  headerRow: 'First row',
  connectorMode: 'Approved API',
  credentialReference: '',
  location: '',
  fileName: null,
};

/** Field names that must never be written, whatever a future edit adds. */
const SECRET_SHAPED = /(password|secret|token|apikey|api_key|clientsecret|client_secret|refresh|bearer|credentialvalue)/i;

/**
 * Strip anything secret-shaped before writing.
 *
 * A denylist is a backstop, not the mechanism — the mechanism is that the
 * wizard never collects a secret in the first place. This exists so that adding
 * a field called `accessToken` in six months fails safe rather than quietly
 * persisting it, because the person adding it will not be reading this comment.
 */
function sanitise(state: WizardState): WizardState {
  const clean = { ...state };
  for (const key of Object.keys(clean) as (keyof WizardState)[]) {
    if (SECRET_SHAPED.test(key)) {
      delete clean[key];
    }
  }
  return clean;
}

export function saveWizardState(state: WizardState): void {
  try {
    window.sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(sanitise(state)));
  } catch {
    // Storage can be unavailable in private modes or when the quota is full.
    // Losing the draft is a nuisance; failing the wizard over it is worse.
  }
}

/**
 * Read the draft back, defensively.
 *
 * Anything unrecognised falls back to the default rather than being trusted:
 * this string came from storage that a previous version of the app — or the
 * user — could have written, so it is input, not state.
 */
export function loadWizardState(): WizardState {
  try {
    const raw = window.sessionStorage.getItem(WIZARD_STORAGE_KEY);
    if (!raw) {
      return { ...EMPTY_WIZARD_STATE };
    }
    const parsed = JSON.parse(raw) as Partial<WizardState>;
    const step = typeof parsed.step === 'number' && parsed.step >= 1 && parsed.step <= 10 ? parsed.step : 1;
    return {
      ...EMPTY_WIZARD_STATE,
      ...sanitise(parsed as WizardState),
      step,
      // Never restored as "still attached" — the bytes did not survive, and the
      // operator has to choose the file again.
      fileName: typeof parsed.fileName === 'string' ? parsed.fileName : null,
    };
  } catch {
    return { ...EMPTY_WIZARD_STATE };
  }
}

export function clearWizardState(): void {
  try {
    window.sessionStorage.removeItem(WIZARD_STORAGE_KEY);
  } catch {
    // Nothing to do; the draft expires with the session regardless.
  }
}
