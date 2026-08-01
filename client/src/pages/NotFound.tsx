import { Link } from 'react-router-dom';
import { Logo } from '../components/marketing/Logo';

/** 404 page for any unmatched route. */
export default function NotFound() {
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
        <Link to="/" className="lf-btn-primary px-6 py-3">
          Back to home
        </Link>
        <Link to="/product" className="lf-btn-secondary px-6 py-3">
          See the product
        </Link>
      </div>
    </div>
  );
}
