import type { BlobStore } from '@xo/storage';
import { ErrorCode } from '@xo/errors';
import type { BenchmarkRun } from '@xo/registry-core';

/** Raw `.xo` archives, keyed by package id (the manifest's merkle root). Written by registry publish, read by install. */
const archiveKey = (packageId: string) => `${encodeURIComponent(packageId)}.xo`;

export async function retainArchive(store: BlobStore, packageId: string, bytes: Uint8Array): Promise<void> {
  const put = await store.put(archiveKey(packageId), bytes, { contentType: 'application/octet-stream' });
  if (!put.ok) throw put.error;
}

export async function loadArchive(store: BlobStore, packageId: string): Promise<Uint8Array | undefined> {
  const raw = await store.get(archiveKey(packageId));
  if (!raw.ok) {
    if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return undefined;
    throw raw.error;
  }
  return raw.value;
}

/** Who published each package into this workspace (the registry records the creator DID, not the publishing identity). */
const OWNERS_KEY = 'package-publishers.json';
const queues = new Map<string, Promise<unknown>>();

export async function readPublishers(state: BlobStore): Promise<Readonly<Record<string, string>>> {
  const raw = await state.get(OWNERS_KEY);
  if (!raw.ok) return {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw.value)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function recordPublisher(state: BlobStore, workspaceId: string, packageId: string, identityId: string): Promise<void> {
  const previous = queues.get(workspaceId) ?? Promise.resolve();
  const run = previous.then(async () => {
    const current = await readPublishers(state);
    // First publisher wins: re-publishing the same content never reassigns who made it.
    if (current[packageId] !== undefined) return;
    const put = await state.put(OWNERS_KEY, JSON.stringify({ ...current, [packageId]: identityId }), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
  });
  queues.set(
    workspaceId,
    run.catch(() => undefined),
  );
  return run;
}

export interface BenchmarkSummary {
  /** Mean of the LATEST score in each category that has one (not of every run). `null` when nothing was recorded. */
  readonly overall: number | null;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly runs: number;
  readonly lastRunAt: string | null;
  /**
   * Always `false`: a recorded run carries no runner identity, so the API cannot say who ran it or that it was run
   * by someone other than the publisher. Do not present these scores as independently verified.
   */
  readonly independentlyVerified: false;
}

export function summarizeBenchmarks(runs: readonly BenchmarkRun[]): BenchmarkSummary {
  const latest = new Map<string, BenchmarkRun>();
  for (const run of runs) {
    const existing = latest.get(run.category);
    if (existing === undefined || run.runAt > existing.runAt) latest.set(run.category, run);
  }
  const byCategory: Record<string, number> = {};
  for (const [category, run] of latest) byCategory[category] = run.score;
  const scores = [...latest.values()].map((r) => r.score);
  const overall = scores.length === 0 ? null : Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  const lastRunAt = runs.length === 0 ? null : runs.reduce((a, b) => (a.runAt > b.runAt ? a : b)).runAt;
  return { overall, byCategory, runs: runs.length, lastRunAt, independentlyVerified: false };
}
