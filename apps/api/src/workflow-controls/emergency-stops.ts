import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ErrorCode, XoError } from '@xo/errors';
import { readInstanceStop, type InstanceStop } from '@xo/instance';
import type { WorkflowComponent } from '@xo/workflow-ir';
import { StartRefusedError } from './service.js';

/**
 * RX-1a (ADR 0048) — scoped emergency stops. Beside the workspace pause (which already holds every start and every call) and the
 * instance-wide stop (`@xo/instance`), a workspace can stop:
 *   - `workflow`: one Workflow entity (`wfl_…`, every version) or one generated definition (`gwf_…`);
 *   - `connector`: every call through one bound connector (`mail`);
 *   - `capability`: one operation of one connector (`mail.send_certificate`).
 * A stop is checked at admission (start, batch preview, schedule slot), before every external call (the effect gate: a refused call
 * is never sent) and, for the instance and workflow scopes, by the engine's kill switch before each step and each item of a batch, so
 * a batch in flight stops at its next item. A call already in flight finishes and is recorded. Releasing a stop restarts nothing.
 *
 * The record lives at `<data>/<workspace>/emergency-stops.json`. A file that exists but cannot be read stops everything in the
 * workspace: the switch fails closed.
 */

export const STOP_SCOPES = ['workflow', 'connector', 'capability'] as const;
export type StopScope = (typeof STOP_SCOPES)[number];

export interface StopRecord {
  readonly scope: StopScope;
  readonly target: string;
  /** For a Workflow entity: the definitions of its versions when the stop was engaged (later versions are caught by the entity id). */
  readonly definitionIds?: readonly string[];
  readonly by: string;
  readonly at: string;
  readonly reason?: string;
}

interface StopFile {
  readonly v: 1;
  readonly stops: readonly StopRecord[];
}

const TARGET: Readonly<Record<StopScope, RegExp>> = {
  workflow: /^(wfl|gwf)_[0-9a-z_]{4,64}$/,
  connector: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
  capability: /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}\.[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
};

export function validateStop(scope: unknown, target: unknown): { scope: StopScope; target: string } {
  if (typeof scope !== 'string' || !(STOP_SCOPES as readonly string[]).includes(scope))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `scope must be one of ${STOP_SCOPES.join(', ')}`);
  if (typeof target !== 'string' || !TARGET[scope as StopScope].test(target))
    throw new XoError(
      ErrorCode.INVALID_ARGUMENT,
      scope === 'workflow'
        ? 'target must be a workflow id (wfl_…) or a generated workflow id (gwf_…)'
        : scope === 'connector'
          ? 'target must be a connector id as bound in the workspace'
          : 'target must be <connector>.<operation>',
    );
  return { scope: scope as StopScope, target };
}

const fileOf = (dataRootDir: string, workspaceId: string): string => join(dataRootDir, workspaceId, 'emergency-stops.json');

const UNREADABLE: StopRecord = {
  scope: 'workflow',
  target: '*',
  by: 'unknown',
  at: new Date(0).toISOString(),
  reason: 'the emergency stop record could not be read, so everything in this workspace is stopped',
};

export async function readStops(dataRootDir: string, workspaceId: string): Promise<readonly StopRecord[]> {
  let text: string;
  try {
    text = await readFile(fileOf(dataRootDir, workspaceId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [UNREADABLE];
  }
  try {
    const f = JSON.parse(text) as StopFile;
    return Array.isArray(f.stops) ? f.stops : [UNREADABLE];
  } catch {
    return [UNREADABLE];
  }
}

// One writer at a time per file in this process; the write itself is atomic (rename), so readers never see half a file.
const queues = new Map<string, Promise<unknown>>();
async function update(
  dataRootDir: string,
  workspaceId: string,
  fn: (s: readonly StopRecord[]) => readonly StopRecord[],
): Promise<readonly StopRecord[]> {
  const path = fileOf(dataRootDir, workspaceId);
  const prev = queues.get(path) ?? Promise.resolve();
  const next = prev.then(async () => {
    const read = await readStops(dataRootDir, workspaceId);
    // An unreadable record is never overwritten from here: it may hold stops nobody can see. Everything stays stopped until an
    // operator repairs or removes the file (docs/runbooks/emergency-stop.md).
    if (read.includes(UNREADABLE))
      throw new XoError(
        ErrorCode.PRECONDITION_FAILED,
        'the emergency stop record of this workspace cannot be read; everything in it stays stopped until an operator repairs the file',
      );
    const current = read;
    const stops = fn(current);
    await mkdir(join(dataRootDir, workspaceId), { recursive: true });
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: 1, stops } satisfies StopFile, null, 2));
    await rename(tmp, path);
    return stops;
  });
  queues.set(
    path,
    next.catch(() => undefined),
  );
  return next;
}

export function engageStop(dataRootDir: string, workspaceId: string, stop: StopRecord): Promise<readonly StopRecord[]> {
  return update(dataRootDir, workspaceId, (s) => [...s.filter((x) => !(x.scope === stop.scope && x.target === stop.target)), stop]);
}

export async function releaseStop(dataRootDir: string, workspaceId: string, scope: StopScope, target: string): Promise<boolean> {
  let found = false;
  await update(dataRootDir, workspaceId, (s) => {
    found = s.some((x) => x.scope === scope && x.target === target);
    return s.filter((x) => !(x.scope === scope && x.target === target));
  });
  return found;
}

/** What a check is about. Every field is optional: a check matches the stops its fields can name. */
export interface StopSubject {
  readonly definitionId?: string;
  readonly workflowId?: string;
  readonly connector?: string;
  readonly operation?: string;
}

export interface StopHit {
  readonly scope: 'instance' | StopScope;
  readonly target: string;
  readonly reason?: string;
  readonly by: string;
  readonly at: string;
}

export function matchStop(instance: InstanceStop | undefined, stops: readonly StopRecord[], s: StopSubject): StopHit | undefined {
  if (instance !== undefined)
    return {
      scope: 'instance',
      target: '*',
      by: instance.by,
      at: instance.at,
      ...(instance.reason !== undefined ? { reason: instance.reason } : {}),
    };
  for (const x of stops) {
    const hit =
      x.target === '*' ||
      (x.scope === 'workflow' &&
        ((s.definitionId !== undefined && (x.target === s.definitionId || x.definitionIds?.includes(s.definitionId) === true)) ||
          (s.workflowId !== undefined && x.target === s.workflowId))) ||
      (x.scope === 'connector' && s.connector !== undefined && x.target === s.connector) ||
      (x.scope === 'capability' && s.connector !== undefined && s.operation !== undefined && x.target === `${s.connector}.${s.operation}`);
    if (hit) return { scope: x.scope, target: x.target, by: x.by, at: x.at, ...(x.reason !== undefined ? { reason: x.reason } : {}) };
  }
  return undefined;
}

export const describeHit = (h: StopHit): string =>
  `${h.scope === 'instance' ? 'the instance-wide emergency stop' : `the emergency stop on ${h.scope} "${h.target}"`} is engaged${h.reason !== undefined ? ` (${h.reason})` : ''}`;

/**
 * The live view a runner uses: refreshed from disk on every effect check (async), read by the engine's synchronous kill switch in
 * between. A refresh that fails keeps everything stopped.
 */
export class EmergencyStops {
  private instance: InstanceStop | undefined;
  private stops: readonly StopRecord[] = [];

  private constructor(
    private readonly dataRootDir: string,
    private readonly workspaceId: string,
  ) {}

  static async load(dataRootDir: string, workspaceId: string): Promise<EmergencyStops> {
    const s = new EmergencyStops(dataRootDir, workspaceId);
    await s.refresh();
    return s;
  }

  async refresh(): Promise<void> {
    try {
      [this.instance, this.stops] = await Promise.all([readInstanceStop(this.dataRootDir), readStops(this.dataRootDir, this.workspaceId)]);
    } catch {
      this.stops = [UNREADABLE];
    }
  }

  check(s: StopSubject): StopHit | undefined {
    return matchStop(this.instance, this.stops, s);
  }

  async checkNow(s: StopSubject): Promise<StopHit | undefined> {
    await this.refresh();
    return this.check(s);
  }
}

/**
 * Admission: the instance stop, a stop on this workflow, or a stop on any connector or operation the workflow can call refuses the
 * start (412, reason `emergency_stop`), before a run record or any effect exists.
 */
export async function enforceNoEmergencyStop(
  dataRootDir: string,
  workspaceId: string,
  subject: { readonly definitionId: string; readonly workflowId?: string; readonly component?: WorkflowComponent },
): Promise<void> {
  const stops = await EmergencyStops.load(dataRootDir, workspaceId);
  const hits: StopHit[] = [];
  const w = stops.check({
    definitionId: subject.definitionId,
    ...(subject.workflowId !== undefined ? { workflowId: subject.workflowId } : {}),
  });
  if (w !== undefined) hits.push(w);
  for (const c of subject.component?.connectors ?? [])
    for (const op of c.operations) {
      const h = stops.check({ connector: c.id, operation: op.name });
      if (h !== undefined) hits.push(h);
    }
  if (hits.length > 0) throw new StartRefusedError('emergency_stop', `Nothing was started: ${describeHit(hits[0]!)}.`);
}
