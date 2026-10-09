import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
/** A deterministic clock for tests that assert on exact timestamps. */
export class FixedClock {
    iso;
    constructor(iso = '2026-01-01T00:00:00.000Z') {
        this.iso = iso;
    }
    now() {
        return new Date(this.iso);
    }
}
/**
 * Runs `fn` against a fresh `LocalFsBlobStore` backed by a real temp
 * directory, then cleans it up — mirrors `package-sdk/test/package-installer.test.ts`'s
 * `withTempStore` helper so registry tests exercise the same real
 * filesystem backend `@xo/registry`'s repositories run against in
 * production, not a mock.
 */
export async function withTempStore(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'xo-registry-'));
    try {
        return await fn(new LocalFsBlobStore(dir));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
//# sourceMappingURL=test-helpers.js.map