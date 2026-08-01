import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../../context/SessionContext';

/**
 * Gate for the application routes.
 *
 * Waits for the initial token revalidation before deciding — redirecting while
 * `loading` is true would bounce a genuinely signed-in user to the sign-in
 * screen on every page load.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <p className="text-sm text-muted">Restoring your session…</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
