import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Contains a render failure to the screen that caused it.
 *
 * WITHOUT THIS, ONE SCREEN TAKES DOWN THE WHOLE APPLICATION. React unmounts the
 * entire tree when a render throws and nothing catches it, so a fault in a
 * single routed pane blanked the sidebar, the top bar and the operator's
 * navigation along with it. That is how /app/sequences presented: a completely
 * empty page, with no message and no way back, and the browser console as the
 * only place the cause existed.
 *
 * IT SHOWS THE ERROR RATHER THAN A FRIENDLY APOLOGY. "Something went wrong" is
 * worth nothing to the person who has to report it and nothing to whoever picks
 * up the report. The message and the component stack are the whole content,
 * because the audience for this panel is an operator who is about to tell
 * somebody what happened.
 *
 * It sits INSIDE the shell, wrapping only the routed outlet, so the nav survives
 * and the operator can leave the broken screen instead of reloading.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ScreenErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept on the console as well as on screen: the stack is more complete here
    // than anything worth rendering, and a copy survives navigating away.
    console.error('[screen] render failed', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="lf-panel border-red/40 p-5">
        <h2 className="text-lg font-semibold text-red">This screen failed to render</h2>
        <p className="mt-1 text-sm text-muted">
          The rest of the application is unaffected — use the sidebar to move somewhere else.
          Quote the message below when you report it.
        </p>

        <p className="mt-4 break-words rounded-lg border border-line bg-panel2 p-3 font-mono text-xs text-text">
          {error.message || String(error)}
        </p>

        {componentStack && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted">Component stack</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-panel2 p-3 text-[11px] text-soft">
              {componentStack}
            </pre>
          </details>
        )}

        <button
          type="button"
          name="retry_screen"
          onClick={() => this.setState({ error: null, componentStack: null })}
          className="lf-btn-secondary mt-4 px-3 py-1.5"
        >
          Try this screen again
        </button>
      </div>
    );
  }
}
