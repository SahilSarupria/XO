import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Statuses a composed workflow execution can end in (mirrors `TERMINAL_WORKFLOW_STATUSES` in the API). Anything else is unfinished. */
const TERMINAL = new Set(['succeeded', 'failed', 'rejected']);

/**
 * ADR 0052 decision 6: the composed runner is removed, so an execution that never finished can no longer be resumed. This counts them per
 * workspace by reading the stored records under `<workspaceDataDir>/<workspaceId>/workflow-executions/<id>/metadata.json`. It returns
 * workspace ids and counts only; a record that cannot be read counts as unfinished (the conservative reading).
 */
export async function countUnfinishedComposedExecutions(workspaceDataDir: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let workspaces: string[];
  try {
    workspaces = await readdir(workspaceDataDir);
  } catch {
    return counts;
  }
  for (const ws of workspaces) {
    let ids: string[];
    try {
      ids = await readdir(join(workspaceDataDir, ws, 'workflow-executions'));
    } catch {
      continue;
    }
    for (const id of ids) {
      let status: unknown;
      try {
        status = (
          JSON.parse(await readFile(join(workspaceDataDir, ws, 'workflow-executions', id, 'metadata.json'), 'utf8')) as { status?: unknown }
        ).status;
      } catch {
        status = undefined;
      }
      if (typeof status === 'string' && TERMINAL.has(status)) continue;
      counts[ws] = (counts[ws] ?? 0) + 1;
    }
  }
  return counts;
}
