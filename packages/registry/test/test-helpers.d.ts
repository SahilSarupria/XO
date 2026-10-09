import { LocalFsBlobStore } from '@xo/storage';
import type { Clock } from '../src/clock.js';
/** A deterministic clock for tests that assert on exact timestamps. */
export declare class FixedClock implements Clock {
    private readonly iso;
    constructor(iso?: string);
    now(): Date;
}
/**
 * Runs `fn` against a fresh `LocalFsBlobStore` backed by a real temp
 * directory, then cleans it up — mirrors `package-sdk/test/package-installer.test.ts`'s
 * `withTempStore` helper so registry tests exercise the same real
 * filesystem backend `@xo/registry`'s repositories run against in
 * production, not a mock.
 */
export declare function withTempStore<T>(fn: (store: LocalFsBlobStore) => Promise<T>): Promise<T>;
//# sourceMappingURL=test-helpers.d.ts.map