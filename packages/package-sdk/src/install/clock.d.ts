/**
 * Time port for the installer's `installedAt` timestamps. Every other
 * side effect the installer needs (filesystem) already goes through the
 * injected {@link BlobStore}; this does the same for the clock rather
 * than calling `new Date()` as a bare global, per
 * docs/CODING_STANDARDS.md. Deliberately not imported from `@xo/testing`
 * — that package is a test-doubles package (see its own description),
 * never a production dependency elsewhere in this repo.
 */
export interface Clock {
    now(): Date;
}
export declare class SystemClock implements Clock {
    now(): Date;
}
//# sourceMappingURL=clock.d.ts.map