import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import type { Clock } from '../src/clock.js';

/** A deterministic clock for tests that assert on exact timestamps. */
export class FixedClock implements Clock {
  constructor(private readonly iso: string = '2026-01-01T00:00:00.000Z') {}
  now(): Date {
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
export async function withTempStore<T>(fn: (store: LocalFsBlobStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-registry-'));
  try {
    return await fn(new LocalFsBlobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
