import assert from 'node:assert/strict';
import { establishAuthenticatedPrincipal, type AuthenticatedPrincipal } from '@xo/permissions';
import { fallbackWorkspaceManager } from '../src/workspace/authorizer.js';
import { AuditService } from '../src/audit/audit-service.js';
import { approveStanding, proposeStanding, startUnderStanding } from '../src/approvals/standing-approval.js';
import { workspaceDefinitionsStore } from '../src/routes/pre-execution-routes.js';
import type { RunnerDeps } from '../src/routes/generated-run-routes.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import type { sched } from './scheduled-batches-fixture.js';
import { people } from './scheduled-batches-fixture.js';

export type Env = Parameters<Parameters<typeof sched>[0]>[0];

/** A signed-in person. The approver of a standing approval must be one; the test server only issues keys, so these are made directly. */
export const human = (id: string): AuthenticatedPrincipal => {
  const r = establishAuthenticatedPrincipal({ kind: 'human', id });
  if (!r.ok) throw r.error;
  return r.value;
};
export const session = () => ({ credential: 'session', authenticatedAt: new Date().toISOString() });

export const LIMITS = { maxItemsPerRun: 5, maxItemsPerPeriod: 20, maxRunsPerPeriod: 3, period: 'day' as const };

export async function standing(
  e: Env,
  opts: {
    n?: number;
    limits?: Record<string, unknown>;
    triggers?: ('manual' | 'schedule')[];
    approve?: boolean;
    expiresInDays?: number;
  } = {},
) {
  const ws = (await e.deps.workspaceStore.get(e.ws)) as unknown as { ok: true; value: WorkspaceRecord };
  const workspace = ws.value;
  const deps: RunnerDeps = {
    ...(e.deps as unknown as RunnerDeps),
    env: {},
    audit: new AuditService(e.audit),
    permissionManager: fallbackWorkspaceManager(),
  };
  const definition = await workspaceDefinitionsStore(workspace, deps.dataConfig).get(e.base.split('/').pop()!);
  const owner = human(workspace.identityId);
  const view = (await proposeStanding(deps, {
    workspace,
    actor: owner,
    definition,
    certificateId: e.certId,
    input: { person_items: people(opts.n ?? 3) },
    limits: opts.limits ?? LIMITS,
    presignSteps: opts.presignSteps ?? [],
    triggers: opts.triggers ?? ['manual', 'schedule'],
    ...(opts.expiresInDays !== undefined ? { expiresInDays: opts.expiresInDays } : {}),
    correlationId: 'corr-propose',
  })) as { standingApprovalId: string; policyDigest: string };
  const reviewer = human('reviewer-1');
  const approve = (
    digest: string = view.policyDigest,
    actor = reviewer,
    auth: Parameters<typeof approveStanding>[1]['auth'] | null = session(),
  ) =>
    approveStanding(deps, {
      workspace,
      actor,
      auth: auth ?? undefined,
      definition,
      id: view.standingApprovalId,
      policyDigest: digest,
      correlationId: 'corr-approve',
    });
  if (opts.approve !== false) await approve();
  const start = (n: number, extra: Partial<Parameters<typeof startUnderStanding>[1]> = {}) =>
    startUnderStanding(deps, {
      workspace,
      actor: owner,
      definition,
      id: view.standingApprovalId,
      trigger: 'manual',
      input: { person_items: people(n) },
      correlationId: 'corr-start',
      ...extra,
    });
  const refused = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (err) {
      return String((err as { context?: { reason?: string } }).context?.reason ?? err);
    }
    assert.fail('expected a refusal');
  };
  return { deps, workspace, definition, owner, reviewer, view, approve, start, refused, id: view.standingApprovalId };
}
