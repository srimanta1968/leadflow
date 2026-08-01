import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, getToken, SessionUser, setToken } from '../services/api';

interface SessionValue {
  user: SessionUser | null;
  /** True until the stored token has been checked against the server. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: {
    email: string;
    password: string;
    first_name?: string;
    last_name?: string;
  }) => Promise<void>;
  signOut: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Holds the signed-in user for the application shell.
 *
 * On mount it revalidates any stored token against `/api/auth/me` rather than
 * trusting local storage — a token can be revoked or expired server-side, and
 * rendering the shell for a session the server rejects produces a page of
 * failed requests instead of an honest sign-in prompt.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function revalidate(): Promise<void> {
      if (!getToken()) {
        if (active) {
          setLoading(false);
        }
        return;
      }
      try {
        const result = await api.me();
        if (active) {
          setUser(result.user);
        }
      } catch {
        // The stored token is no longer good; drop it rather than keeping a
        // session that will fail every subsequent request.
        setToken(null);
        if (active) {
          setUser(null);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void revalidate();
    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<void> => {
    const result = await api.login({ email, password });
    setToken(result.token);
    setUser(result.user);
  }, []);

  const signUp = useCallback(
    async (input: {
      email: string;
      password: string;
      first_name?: string;
      last_name?: string;
    }): Promise<void> => {
      const result = await api.register(input);
      setToken(result.token);
      setUser(result.user);
    },
    []
  );

  const signOut = useCallback((): void => {
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ user, loading, signIn, signUp, signOut }),
    [user, loading, signIn, signUp, signOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Read the current session.
 * @throws Error when called outside a `SessionProvider`.
 */
export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return context;
}
