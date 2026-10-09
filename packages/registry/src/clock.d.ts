/**
 * Time port for the registry's `recordedAt`/`publishedAt` timestamps.
 * Every other side effect the repositories need (filesystem) already
 * goes through an injected `@xo/storage` `BlobStore`; this does the same
 * for the clock rather than calling `new Date()` as a bare global, per
 * docs/CODING_STANDARDS.md — the same local-port pattern `@xo/package-sdk`
 * uses in `src/install/clock.ts` (and for the same reason: `@xo/testing`
 * is a test-doubles package, never a production dependency elsewhere in
 * this repo).
 */
export interface Clock {
    now(): Date;
}
export declare class SystemClock implements Clock {
    now(): Date;
}
//# sourceMappingURL=clock.d.ts.map