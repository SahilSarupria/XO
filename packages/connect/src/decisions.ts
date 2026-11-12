import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewDecision } from '@xo/environment-intelligence';

/**
 * Durable review decisions (C7). C5's model keeps decisions in memory only, so a restart reopens every conflict. A decision is a small,
 * content-free record (kind, identifier keys or value digests, reviewer id, time, operation id): it does not depend on assertion ids, so it
 * re-applies cleanly when knowledge is re-derived. The decision was authorized and audited by C6 when it was made; replaying it restores
 * state, it does not re-decide it.
 */
export class DecisionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionStoreError';
  }
}

export interface DecisionStore {
  load(): Promise<readonly ReviewDecision[]>;
  /** Replaces the whole set atomically. Throws if it cannot be persisted. */
  save(decisions: readonly ReviewDecision[]): Promise<void>;
}

export class InMemoryDecisionStore implements DecisionStore {
  private decisions: readonly ReviewDecision[] = [];
  async load(): Promise<readonly ReviewDecision[]> {
    return this.decisions;
  }
  async save(decisions: readonly ReviewDecision[]): Promise<void> {
    this.decisions = decisions;
  }
}

const KINDS = ['approve_merge', 'block_merge', 'resolve_conflict'];

function valid(d: unknown): d is ReviewDecision {
  if (d === null || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['kind'] === 'string' &&
    KINDS.includes(o['kind']) &&
    Array.isArray(o['subject']) &&
    o['subject'].every((x) => typeof x === 'string') &&
    typeof o['principalId'] === 'string' &&
    typeof o['decidedAt'] === 'string' &&
    typeof o['operationId'] === 'string'
  );
}

/**
 * One JSON file, replaced atomically. A corrupt or unrecognised file is an ERROR, never "no decisions": starting empty would silently
 * reopen decided conflicts and hide that decisions were ever made.
 */
export class FileDecisionStore implements DecisionStore {
  private readonly file: string;
  constructor(private readonly dir: string) {
    this.file = join(dir, 'review-decisions.json');
  }

  async load(): Promise<readonly ReviewDecision[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new DecisionStoreError('the review decisions could not be read');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DecisionStoreError('the review decisions file is not valid');
    }
    const p = parsed as { version?: unknown; decisions?: unknown } | null;
    if (p === null || typeof p !== 'object' || p.version !== 1 || !Array.isArray(p.decisions) || !p.decisions.every(valid))
      throw new DecisionStoreError('the review decisions file has an unrecognised format');
    return p.decisions;
  }

  async save(decisions: readonly ReviewDecision[]): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, decisions }), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch {
      throw new DecisionStoreError('the review decisions could not be saved');
    }
  }
}
