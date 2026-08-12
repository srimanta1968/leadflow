import { Link } from 'react-router-dom';
import { Logo } from '../components/marketing/Logo';
import { useSession } from '../context/SessionContext';

/**
 * 404 page for any unmatched route.
 *
 * WHERE "HOME" IS DEPENDS ON WHO IS ASKING. This sent everyone to `/`, the
 * PUBLIC MARKETING SITE — so a signed-in operator who mistyped a URL or
 * followed a stale link was dumped out of the application onto the sales page.
 * Nothing had logged them out, but it is indistinguishable from having been
 * logged out, which is worse: they re-authenticate to get back to a session
 * they never lost.
 *
 * A signed-in user goes back to the workspace; only an anonymous visitor is
 * sent to the marketing site, where "home" genuinely means the landing page.
 */
export default function NotFound() {
  const { user } = useSession();
  const signedIn = Boolean(user);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-6 text-center">
      <Logo />
      <p className="mt-10 font-mono text-sm font-bold text-blue">404</p>
      <h1 className="mt-3 text-3xl font-bold text-text">That page does not exist</h1>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
        The link may be out of date, or the screen may be one of the tracked epics that has not
        shipped yet.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link to={signedIn ? '/app' : '/'} className="lf-btn-primary px-6 py-3">
          {signedIn ? 'Back to the workspace' : 'Back to home'}
        </Link>
        {!signedIn && (
          <Link to="/product" className="lf-btn-secondary px-6 py-3">
            See the product
          </Link>
        )}
      </div>
    </div>
  );
}
