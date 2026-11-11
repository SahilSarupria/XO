import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PageRecovery, RecoveryCache } from './types.js';

/**
 * A persistent recovery cache on disk. Keys are content hashes (document bytes + page + tier name + tier version), so a
 * changed engine version or a changed document can never read a stale answer. Safe under concurrent writers, including
 * separate processes: every write goes to a unique temp file and is moved into place with an atomic rename, and a key
 * always maps to the same content, so racing writers are harmless. A truncated or tampered entry fails its checksum and is
 * treated as a miss, never as data.
 */
export class FileRecoveryCache implements RecoveryCache {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^a-f0-9]/g, '').slice(0, 64)}.json`);
  }

  get(key: string): PageRecovery | undefined {
    const file = this.path(key);
    if (!existsSync(file)) return undefined;
    try {
      const { sum, body } = JSON.parse(readFileSync(file, 'utf8')) as { sum: string; body: string };
      if (createHash('sha256').update(body).digest('hex') !== sum) return undefined;
      return JSON.parse(body) as PageRecovery;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: PageRecovery): void {
    const body = JSON.stringify(value);
    const sum = createHash('sha256').update(body).digest('hex');
    const tmp = `${this.path(key)}.${process.pid}.${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 12)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sum, body }));
    renameSync(tmp, this.path(key));
  }
}
