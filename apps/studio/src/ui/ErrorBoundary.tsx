import { Component, type ErrorInfo, type ReactNode } from 'react';
import { componentOf } from '../platform/errorReport';

/**
 * S1-3: a screen that fails to render shows a calm recovery screen instead of a blank page. Reload keeps the person's place (the
 * address is the place, S1-3). The failure is reported without content (platform/errorReport.ts). `resetKey` clears the
 * failure when the person goes somewhere else.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; onError?: (error: unknown, component: string | undefined) => void; resetKey?: string; onHome?: () => void },
  { failed: boolean; key: string | undefined }
> {
  override state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { failed: boolean; key: string | undefined },
  ): Partial<{ failed: boolean; key: string | undefined }> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, componentOf(info.componentStack));
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="recover" role="alert">
        <h2>Something went wrong on this screen</h2>
        <p className="muted">Nothing you saved was lost. Reloading usually fixes this, and you will come back to the same place.</p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          {this.props.onHome !== undefined ? (
            <button type="button" className="btn btn-secondary" onClick={this.props.onHome}>
              Go to Home
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}
