import type { ClientErrorReport } from './client';
import { STUDIO_VERSION } from './build';

/**
 * S1-3 (plan 6.4): reports an uncaught error, an unhandled rejection or a failed render to `POST /client-errors`, WITHOUT
 * content. Studio removes content first (the server does again and does not trust Studio to have): the message becomes a
 * template, the route keeps only its shape, and the component is a name. Each distinct report is sent once per page load, with
 * a count of repeats folded into the next distinct one, and at most MAX_REPORTS are sent per page load. Reporting never throws
 * and never shows anything: a failed report is dropped.
 */
export const MAX_REPORTS = 10;

/** The same reduction as the server's: quoted text, addresses, links, ids and numbers become placeholders; at most 160 characters. */
export function messageTemplate(message: string): string {
  return message
    .slice(0, 400)
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, '<text>')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<address>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[a-z]{2,6}_[A-Za-z0-9]{6,}\b/g, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(?:[.,]\d+)*/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** `/w/ws_123/work/runs` -> `/w/:id/work/runs`: any segment that is not a plain word becomes ":id". */
export function routePattern(pathname: string): string {
  return pathname
    .split('/')
    .map((s) => (s === '' || /^[a-z]+(?:-[a-z]+)*$/.test(s) ? s : ':id'))
    .join('/')
    .slice(0, 120);
}

/** The first component named in a React component stack, if it is a plain name. */
export function componentOf(stack: string | null | undefined): string | undefined {
  const m = /(?:at|in) ([A-Z][A-Za-z0-9]*)/.exec(stack ?? '');
  return m?.[1] !== undefined && m[1].length <= 60 ? m[1] : undefined;
}

type Send = (r: ClientErrorReport) => Promise<unknown>;

export class ErrorReporter {
  private readonly seen = new Map<string, number>();
  private sent = 0;
  constructor(
    private readonly send: Send,
    private readonly where: () => string = () => window.location.pathname,
  ) {}

  report(kind: ClientErrorReport['kind'], error: unknown, component?: string): void {
    try {
      const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'non-error value thrown';
      const message = messageTemplate(raw.length > 0 ? raw : 'empty message');
      const key = `${kind}|${message}|${component ?? ''}`;
      const n = (this.seen.get(key) ?? 0) + 1;
      this.seen.set(key, n);
      if (n > 1 || this.sent >= MAX_REPORTS) return;
      this.sent += 1;
      const report: ClientErrorReport = {
        kind,
        message,
        ...(component !== undefined ? { component } : {}),
        route: routePattern(this.where()),
        build: STUDIO_VERSION,
        count: 1,
      };
      void this.send(report).catch(() => undefined);
    } catch {
      /* reporting must never fail the page */
    }
  }

  /** Listens for uncaught errors and unhandled rejections; returns the function that stops listening. */
  install(target: Window = window): () => void {
    const onError = (e: ErrorEvent) => this.report('uncaught', e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => this.report('unhandled-rejection', e.reason);
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    return () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
    };
  }
}
