import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import { CACHE_FORMAT_VERSION, type CacheEntry, type InvalidatableCapabilityCache } from './cache.js';
import { redactSecrets } from './redaction.js';

export interface FileCapabilityCacheOptions {
  /** Directory owned by this cache. Created (0700) if missing. */
  readonly directory: string;
  /** Entries older than this are treated as misses (and left for explicit `invalidate`/`clear`). Omit = never expire. */
  readonly ttlMs?: number;
  /** Credentials currently held by this process. A value whose serialisation contains one is NEVER written. */
  readonly secrets?: readonly string[];
  readonly clock?: Clock;
  readonly logger?: Logger;
}

interface Envelope {
  readonly formatVersion: number;
  readonly key: string;
  readonly storedAtMs: number;
  readonly value: unknown;
}

/** `computeCacheKey` returns `sha256:<64 hex>`. Only that exact shape is accepted; the hex part becomes the filename (no ':' for portability, no traversal). */
const KEY_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/;
const ENTRY_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;

/**
 * Durable, single-host capability cache: one JSON file per key (`<sha256 hex>.json`) so identical eligible compilations can reuse
 * validated results across process restarts.
 *
 * Properties and limits (deliberate):
 * - Writes are atomic (temp file + `rename`), so a crash or a concurrent writer can never leave a half-written entry; two
 *   processes writing the same key race benignly (identical content-addressed key, last rename wins).
 * - Every read is verified (valid JSON, matching `formatVersion`, `envelope.key === key`); anything else is a MISS, never an
 *   error — a corrupt entry cannot break a compile. The router additionally re-validates a hit against the current schema.
 * - Keys must be `computeCacheKey` digests (`sha256:<64 hex>`); the hex becomes the filename, which also rules out path traversal.
 * - Files are 0600 in a 0700 directory: cached outputs can contain text extracted from private documents.
 * - Secrets are never written: a value containing any configured secret or a Google-API-key-shaped string is skipped.
 * - NOT a shared cache: no cross-host coordination, no size bound, no automatic eviction. A production fleet should put a
 *   shared backend behind the same `CapabilityCache` interface. Invalidation is explicit (`invalidate`, `clear`).
 */
export class FileCapabilityCache implements InvalidatableCapabilityCache {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private ready: Promise<void> | undefined;

  constructor(private readonly options: FileCapabilityCacheOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.logger = (options.logger ?? noopLogger).child({ component: 'ai-core.file-cache' });
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    if (!KEY_PATTERN.test(key)) return undefined;
    let raw: string;
    try {
      raw = await readFile(this.path(key), 'utf8');
    } catch {
      return undefined;
    }
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      this.logger.warn('cache.entry.corrupt', { reason: 'invalid_json' });
      return undefined;
    }
    if (envelope.formatVersion !== CACHE_FORMAT_VERSION || envelope.key !== key || typeof envelope.storedAtMs !== 'number') {
      this.logger.warn('cache.entry.rejected', { reason: 'envelope_mismatch' });
      return undefined;
    }
    if (this.options.ttlMs !== undefined && this.clock.now() - envelope.storedAtMs > this.options.ttlMs) return undefined;
    return { value: envelope.value as T, storedAtMs: envelope.storedAtMs };
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!KEY_PATTERN.test(key)) return;
    const envelope: Envelope = { formatVersion: CACHE_FORMAT_VERSION, key, storedAtMs: this.clock.now(), value };
    const serialized = JSON.stringify(envelope);
    if (redactSecrets(serialized, this.options.secrets ?? []) !== serialized) {
      this.logger.warn('cache.entry.skipped', { reason: 'contains_secret' });
      return;
    }
    try {
      await this.ensureDirectory();
      const finalPath = this.path(key);
      const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, serialized, { mode: 0o600 });
      await rename(tmpPath, finalPath);
    } catch (error) {
      // An unwritable cache degrades to "no cache", never to a failed compile.
      this.logger.warn('cache.write.failed', { error: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
    }
  }

  async invalidate(key: string): Promise<boolean> {
    if (!KEY_PATTERN.test(key)) return false;
    try {
      await rm(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Removes every entry this cache owns (only `<hex>.json` files; never anything else in the directory). Returns the count. */
  async clear(): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await readdir(this.options.directory);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (ENTRY_FILE_PATTERN.test(name)) {
        try {
          await rm(join(this.options.directory, name));
          removed += 1;
        } catch {
          /* already gone */
        }
      }
    }
    return removed;
  }

  private path(key: string): string {
    const hex = KEY_PATTERN.exec(key)?.[1];
    if (!hex) throw new Error('invalid cache key');
    return join(this.options.directory, `${hex}.json`);
  }

  private ensureDirectory(): Promise<void> {
    this.ready ??= mkdir(this.options.directory, { recursive: true, mode: 0o700 }).then(() => undefined);
    return this.ready;
  }
}
