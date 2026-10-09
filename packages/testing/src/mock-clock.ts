/**
 * A controllable clock for deterministic time-dependent tests. Any code
 * that needs `Date.now()` or `new Date()` should take a `Clock` dependency
 * instead of calling those globals directly.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class MockClock implements Clock {
  private current: Date;

  constructor(initial: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = typeof initial === 'string' ? new Date(initial) : initial;
  }

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date | string): void {
    this.current = typeof date === 'string' ? new Date(date) : date;
  }
}
