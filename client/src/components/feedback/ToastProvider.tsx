import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Message, MessageTone } from '../../content/messages';

interface Toast extends Message {
  id: number;
}

interface ToastValue {
  /** Show a message. Returns the id so a caller can dismiss it early. */
  notify: (message: Message) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

/** How long each tone stays on screen. Errors persist until dismissed. */
const LIFETIME_MS: Record<MessageTone, number | null> = {
  success: 5000,
  info: 4000,
  warning: 8000,
  error: null,
};

/** Token classes per tone, keeping colour meaning consistent with the app. */
const TONE_CLASS: Record<MessageTone, string> = {
  success: 'border-green/40 bg-green/[0.08]',
  info: 'border-blue/40 bg-blue/[0.08]',
  warning: 'border-gold/40 bg-gold/[0.08]',
  error: 'border-red/40 bg-red/[0.08]',
};

const TONE_ICON_CLASS: Record<MessageTone, string> = {
  success: 'text-green',
  info: 'text-blue',
  warning: 'text-gold',
  error: 'text-red',
};

/**
 * Application-wide success and failure messaging.
 *
 * Transient confirmations belong here rather than inline: an operator who has
 * just navigated away should still learn the capture succeeded. Failures are
 * deliberately NOT auto-dismissed — a message someone missed is a message that
 * did not do its job, and an error usually needs an action.
 *
 * Accessibility is the reason this is one component rather than per-screen
 * markup. Two live regions are rendered: `polite` for confirmations, so they do
 * not interrupt, and `assertive` for failures, so they do. A toast that is only
 * visible is invisible to a screen-reader user.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback(
    (message: Message): number => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current, { ...message, id }]);

      const lifetime = LIFETIME_MS[message.tone];
      if (lifetime !== null) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), lifetime)
        );
      }
      return id;
    },
    [dismiss]
  );

  // Clear every outstanding timer on unmount so a pending dismissal cannot fire
  // against an unmounted tree.
  useEffect(
    () => () => {
      timers.current.forEach((timer) => clearTimeout(timer));
      timers.current.clear();
    },
    []
  );

  const value = useMemo<ToastValue>(() => ({ notify, dismiss }), [notify, dismiss]);

  const polite = toasts.filter((toast) => toast.tone !== 'error');
  const assertive = toasts.filter((toast) => toast.tone === 'error');

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        className="pointer-events-none fixed bottom-0 right-0 z-[100] flex w-full max-w-sm flex-col gap-3 p-4 sm:p-6"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {polite.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>

      <div
        className="pointer-events-none fixed bottom-0 right-0 z-[100] flex w-full max-w-sm flex-col gap-3 p-4 sm:p-6"
        aria-live="assertive"
        aria-relevant="additions text"
      >
        {assertive.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** One rendered toast. */
function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  return (
    <div
      className={`pointer-events-auto animate-fade-up rounded-xl border p-4 shadow-panel backdrop-blur-xl ${TONE_CLASS[toast.tone]}`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 shrink-0 ${TONE_ICON_CLASS[toast.tone]}`} aria-hidden="true">
          {toast.tone === 'success' ? (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M4 9.5l3.2 3.2L14 5.6"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="7.2" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M9 5.4v4.4M9 12.4v.5"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text">{toast.title}</p>
          {toast.detail && (
            <p className="mt-1 text-xs leading-relaxed text-muted">{toast.detail}</p>
          )}
        </div>

        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-soft transition-colors hover:text-text"
          aria-label={`Dismiss: ${toast.title}`}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * Access the notifier.
 * @throws Error when called outside a `ToastProvider`.
 */
export function useToast(): ToastValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside a ToastProvider');
  }
  return context;
}
