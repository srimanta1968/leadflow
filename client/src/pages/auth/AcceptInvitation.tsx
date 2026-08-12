import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, setToken } from '../../services/api';

/**
 * Claim an invited account by choosing its first password.
 *
 * THIS LINK IS THE ONLY WAY IN. An invited account is created with an unusable
 * credential and `is_active = FALSE`, so somebody who loses this email has an
 * account they cannot sign in to and cannot reset either — there is no "forgot
 * password" path into a credential that was never set. That is why the failure
 * text says to ask for a new invitation rather than offering a reset that would
 * do nothing.
 *
 * DOES NOT REDEEM ON ARRIVAL, unlike the confirmation page. The token is spent
 * by the act of setting a password, and a mail client prefetching the link must
 * not consume an invitation before the person has chosen one.
 *
 * SIGNS IN ON SUCCESS. Somebody who has just typed a password twice should not
 * be sent to a form to type it a third time.
 */
export default function AcceptInvitation() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= 8 && confirm === password && token !== '';

  const accept = async () => {
    if (!ready) return;
    setSaving(true);
    setFailure(null);
    try {
      const result = await api.acceptInvitation(token, password);
      // The response carries a session, so store it through the module's own
      // setter — the storage key is its business, not this page's.
      setToken(result.token);
      navigate('/app');
    } catch (caught) {
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : 'The invitation could not be accepted. Ask for a new one.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-md px-4 py-20">
      <h1 className="text-2xl font-bold text-text">Choose a password</h1>
      <p className="mt-1.5 text-sm text-muted">
        Your account exists but cannot be signed in to until you set one.
      </p>

      {token === '' && (
        <p role="alert" className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          This link is missing its token. Open the link from your invitation exactly as it arrived.
        </p>
      )}

      <div className="mt-6 space-y-4">
        <div>
          <label className="lf-label block" htmlFor="new_password">
            Password
          </label>
          <input
            id="new_password"
            name="password"
            type="password"
            autoComplete="new-password"
            className="lf-input mt-1 w-full"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className={`mt-1 text-xs ${tooShort ? 'text-red' : 'text-soft'}`}>
            At least 8 characters.
          </p>
        </div>

        <div>
          <label className="lf-label block" htmlFor="confirm_password">
            Confirm password
          </label>
          <input
            id="confirm_password"
            name="confirm_password"
            type="password"
            autoComplete="new-password"
            className="lf-input mt-1 w-full"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {/* Checked here rather than only on submit: a mismatch discovered
              after pressing the button reads as a rejected password. */}
          {mismatch && <p className="mt-1 text-xs text-red">The two do not match.</p>}
        </div>

        {failure && (
          <p role="alert" className="rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
            {failure} Invitations expire after 7 days and work once.
          </p>
        )}

        <button
          type="button"
          name="accept_invitation"
          disabled={!ready || saving}
          onClick={() => void accept()}
          className="lf-btn-primary w-full px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Setting your password...' : 'Set password and sign in'}
        </button>
      </div>
    </div>
  );
}
