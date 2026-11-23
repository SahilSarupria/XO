/** S1-3 — error reports carry no content, are sent once each, and at most ten per page load. */
import { describe, expect, it } from 'vitest';
import { ErrorReporter, MAX_REPORTS, componentOf, messageTemplate, routePattern } from '../../src/platform/errorReport';
import { STUDIO_VERSION } from '../../src/platform/build';
import type { ClientErrorReport } from '../../src/platform/client';

describe('content is removed before a report leaves Studio', () => {
  it('reduces a message to a template', () => {
    expect(messageTemplate(`Cannot read 'Asha Rao' of undefined at row 12`)).toBe('Cannot read <text> of undefined at row <n>');
    expect(messageTemplate('mail to asha@example.com failed, see https://x.test/a?b=1')).toBe('mail to <address> failed, see <url>');
    expect(messageTemplate('run_ab12cd34ef missing; digest 0123456789abcdef')).toBe('<id> missing; digest <id>');
    expect(messageTemplate('x'.repeat(500))).toHaveLength(160);
  });
  it('keeps only the shape of a route, and only a plain component name', () => {
    expect(routePattern('/w/ws_7f3a/work/runs')).toBe('/w/:id/work/runs');
    expect(routePattern('/w/Claims%20Ops/activity/audit')).toBe('/w/:id/activity/audit');
    expect(componentOf('\n    at LibrarySection (http://x/src/ui/LibrarySection.tsx:10:3)\n    at div')).toBe('LibrarySection');
    expect(componentOf('    in Broken\n    in ErrorBoundary')).toBe('Broken');
    expect(componentOf(undefined)).toBeUndefined();
  });
});

describe('ErrorReporter', () => {
  it('sends each distinct report once, with the build and the route pattern', () => {
    const sent: ClientErrorReport[] = [];
    const r = new ErrorReporter(
      async (x) => sent.push(x),
      () => '/w/ws_1/home',
    );
    r.report('uncaught', new Error('boom at 3'));
    r.report('uncaught', new Error('boom at 4')); // the same template: not sent again
    r.report('render', new Error('boom at 3'), 'Home');
    expect(sent).toEqual([
      { kind: 'uncaught', message: 'boom at <n>', route: '/w/:id/home', build: STUDIO_VERSION, count: 1 },
      { kind: 'render', message: 'boom at <n>', component: 'Home', route: '/w/:id/home', build: STUDIO_VERSION, count: 1 },
    ]);
  });
  it(`sends at most ${MAX_REPORTS} per page load, never throws, and ignores a failed send`, () => {
    const sent: ClientErrorReport[] = [];
    const r = new ErrorReporter(async (x) => {
      sent.push(x);
      throw new Error('offline');
    });
    for (let i = 0; i < 30; i++) r.report('uncaught', new Error(`distinct ${'a'.repeat(i)}`));
    r.report('unhandled-rejection', undefined);
    expect(sent).toHaveLength(MAX_REPORTS);
  });
  it('listens for uncaught errors and unhandled rejections until uninstalled', () => {
    const sent: ClientErrorReport[] = [];
    const r = new ErrorReporter(
      async (x) => sent.push(x),
      () => '/',
    );
    // A stand-in for window: the test runner itself listens for errors dispatched on the real one.
    const target = new EventTarget() as unknown as Window;
    const stop = r.install(target);
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('one') }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('two');
    target.dispatchEvent(rejection);
    stop();
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('three') }));
    expect(sent.map((s) => [s.kind, s.message])).toEqual([
      ['uncaught', 'one'],
      ['unhandled-rejection', 'two'],
    ]);
  });
});
