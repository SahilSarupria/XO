/**
 * Time port for grant/decision/audit timestamps. Deliberately not imported
 * from `@xo/testing` — that package is a test-doubles package, never a
 * production dependency elsewhere in this repo (see `@xo/package-sdk`'s
 * `install/clock.ts`, which documents the same convention). Tests in this
 * package may use `@xo/testing`'s `MockClock` as a `devDependency`; nothing
 * under `src/` may.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
