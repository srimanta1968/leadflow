import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../services/api';

/**
 * The landing page for a confirmation link.
 *
 * REDEEMS ON ARRIVAL, once. The token is in the URL because it arrived in an
 * email, and asking the person to press a second button after they already
 * pressed one in their inbox adds a step that protects nothing. The guard
 * against a double redemption is server side and atomic, so a mail client that
 * prefetches the link cannot spend it and leave the person looking at a failure.
 *
 * THE THREE OUTCOMES ARE DISTINCT. Confirmed, already-confirmed and
 * link-not-valid are different things to the reader, and collapsing them into
 * one error is how somebody whose address is already fine concludes it is not.
 * The server answers one way for wrong/spent/expired — deliberately, so nobody
 * can probe for live tokens — so this page says what that single answer means
 * in the reader's terms rather than inventing a distinction the API refuses to
 * make.
 */

type State = 'working' | 'confirmed' | 'failed';

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<State>('working');
  const [detail, setDetail] = useState<string | null>(null);
  const [resendTo, setResendTo] = useState('');
  const [resent, setResent] = useState(false);

  const verify = useCallback(async () => {
    if (token === '') {
      setState('failed');
      setDetail('This link is missing its token. Open the link from your email exactly as it arrived.');
      return;
    }
    try {
      await api.verifyEmail(token);
      setState('confirmed');
    } catch (caught) {
      setState('failed');
      setDetail(
        caught instanceof ApiError
          ? caught.message
          : 'The confirmation could not be completed. Try the link again.',
      );
    }
  }, [token]);

  useEffect(() => {
    void verify();
  }, [verify]);

  const resend = async () => {
    if (resendTo.trim() === '') return;
    try {
      await api.resendVerification(resendTo.trim());
    } catch {
      // The endpoint answers the same way whether or not the address is on the
      // register, so there is nothing here worth reporting differently.
    }
    setResent(true);
  };

  return (
    <div className="mx-auto max-w-md px-4 py-20">
      <h1 className="text-2xl font-bold text-text">Confirm your email address</h1>

      {state === 'working' && (
        <p role="status" className="mt-4 text-sm text-muted">
          Confirming...
        </p>
      )}

      {state === 'confirmed' && (
        <>
          <p className="mt-4 rounded border border-green/40 bg-green/10 px-3 py-2 text-sm text-green">
            Your email address is confirmed.
          </p>
          <Link to="/signin" className="lf-btn-primary mt-5 inline-block px-4 py-2">
            Sign in
          </Link>
        </>
      )}

      {state === 'failed' && (
        <>
          <p role="alert" className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
            {detail}
          </p>
          <p className="mt-4 text-sm text-muted">
            Links expire after 24 hours and work once. If yours has been used or has expired, ask
            for another.
          </p>

          {resent ? (
            <p className="mt-3 text-sm text-muted">
              If that address has an unconfirmed account, a new link is on its way.
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="flex-1">
                <label className="lf-label block" htmlFor="resend_email">
                  Your email address
                </label>
                <input
                  id="resend_email"
                  name="email"
                  type="email"
                  className="lf-input mt-1 w-full"
                  value={resendTo}
                  onChange={(e) => setResendTo(e.target.value)}
                />
              </div>
              <button
                type="button"
                name="resend_verification"
                onClick={() => void resend()}
                className="lf-btn-secondary px-4 py-2"
              >
                Send another
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
