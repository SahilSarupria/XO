/**
 * ADR 0030 — a workspace's connector bindings: the operator's statement of how each declared operation is carried out
 * (connector, operation, side effect, undo, host adapter). Sources state that an operation exists; only the operator knows
 * the destination and its effects, so act/compensate steps are generated from these and nothing else.
 */
import { join } from 'node:path';
import { ErrorCode, XoError } from '@xo/errors';
import { LocalFsBlobStore } from '@xo/storage';
import { ConnectorBindingsError, parseConnectorBindings as parseBindings, type ConnectorBinding } from '@xo/pre-execution';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';

const KEY = 'connector-bindings.json';
export interface StoredBindings {
  readonly revision: number;
  readonly bindings: readonly ConnectorBinding[];
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

function store(workspace: WorkspaceRecord, config: WorkspaceDataConfig): LocalFsBlobStore {
  return new LocalFsBlobStore(join(config.dataRootDir, workspace.workspaceId, 'pre-execution'));
}

export async function readConnectorBindings(workspace: WorkspaceRecord, config: WorkspaceDataConfig): Promise<StoredBindings> {
  const raw = await store(workspace, config).get(KEY);
  if (!raw.ok) return { revision: 0, bindings: [] };
  return JSON.parse(new TextDecoder().decode(raw.value)) as StoredBindings;
}

export async function writeConnectorBindings(
  workspace: WorkspaceRecord,
  config: WorkspaceDataConfig,
  value: StoredBindings,
): Promise<void> {
  const r = await store(workspace, config).replace(KEY, JSON.stringify(value), { contentType: 'application/json' });
  if (!r.ok) throw r.error;
}

/** Validates a request body field by field; no extra fields are carried into the stored bindings. */
export function parseConnectorBindings(v: unknown): ConnectorBinding[] {
  try {
    return parseBindings(v);
  } catch (cause) {
    if (cause instanceof ConnectorBindingsError) throw new XoError(ErrorCode.INVALID_ARGUMENT, cause.message);
    throw cause;
  }
}
