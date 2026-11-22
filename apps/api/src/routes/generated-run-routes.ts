import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { SYSTEM_ACTOR, actorFromPrincipal } from '@xo/audit';
import { ConnectorError, ConnectorHost, CredentialError, MapVault, type Connector, type Json } from '@xo/connectors';
import type { AdapterCredential } from '@xo/adapters';
import { loadCredentialsConfig, workspaceBroker } from '../credentials/credentials.js';
import {
  LeaseAuthority,
  LeasedRunStore,
  effectsOf,
  LeaseError,
  RunStore,
  StaticReviewerRegistry,
  WorkflowRunner,
  ApprovalError,
  RunInputError,
  signDecision,
  type RunResult,
} from '@xo/workflow-runtime';
import type { AuthenticatedPrincipal, PermissionManager } from '@xo/permissions';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { ExternalToolAdapter } from '@xo/adapters';
import type { WorkflowComponent } from '@xo/workflow-ir';
import { basename, dirname, join } from 'node:path';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId, safeId } from '../audit/audit-service.js';
import { workspaceDefinitionsStore, type WorkflowDefinitionRecord } from './pre-execution-routes.js';
import { verifyCertificateNow, workspaceCertificatesStore } from './readiness-routes.js';
import { readConnectorBindings, writeConnectorBindings, parseConnectorBindings } from '../pre-execution/connector-bindings.js';
import { approvalKeyring, currentPublicKeys, verifyJournaledDecision } from '../pre-execution/approval-keys.js';
import { effectAuthorizer, type EffectCall } from '../pre-execution/effect-authorization.js';
import { FsControlsStore } from '../workflow-controls/fs-controls-store.js';
import { enforceNotPaused } from '../workflow-controls/service.js';
import { exceptionReport } from '../workflow-controls/exceptions.js';
import { checkDataDrift, driftSummary } from '../drift/data-drift.js';
import { emailTierOf } from '../email/mail-adapter.js';
import {
  BatchStore,
  actionDigest,
  batchDir,
  buildPreview,
  digestOfJson,
  exceptionsFirst,
  hasEffects,
  newBatchApprovalId,
  signBatchApproval,
  type BatchApprovalPayload,
  type BatchApprovalRecord,
  type PreviewItemsSource,
  type PreviewRecord,
  type SenderView,
} from '../approvals/batch-approval.js';
import { adapterFor, installedAdapterIds, workspaceStateStore } from '../workspace/workspace-context.js';
import { workspaceWorkflowEntitiesStore } from '../workflow-entities/entity-store.js';
import { EmergencyStops, describeHit, enforceNoEmergencyStop } from '../workflow-controls/emergency-stops.js';
import { StartRefusedError } from '../workflow-controls/service.js';
import { componentSha256, writeManifest } from '../runs/run-manifest.js';
import { workspaceRateLimiters } from '../workflow-controls/connector-rate-limits.js';
import {
  itemsFromConfirmedSource,
  listItemSources,
  parseItemSourceRef,
  type ItemSourceRef,
} from '../source-connections/items-from-sources.js';

/**
 * ADR 0030 — generated workflows run as Workflow IR, interpreted by `@xo/workflow-runtime`: the definition the readiness
 * certificate binds is the definition that runs. Every start presents a current READY certificate for that exact generated
 * workflow (re-verified now, whatever the workspace setting). Human steps wait for a person; the platform signs each
 * decision on behalf of the authenticated reviewer (review role, recent sign-in), so the run's journal records who decided.
 * Connector steps go through `ConnectorHost` to the adapters the host installed for the workspace's bindings; an unknown
 * outcome is never retried silently, it escalates.
 *
 * Runs are journaled per generated workflow under `<data>/<workspace>/generated-runs/<definitionId>/` (hash-chained,
 * restart-safe). ADR 0031:
 *   - every connector call is authorized again at the moment it is made (`effect-authorization.ts`), not only at start;
 *   - decisions are signed with the instance's durable, governed key (`approval-keys.ts`), so pending approvals and past
 *     decisions survive restarts and verify on every instance;
 *   - every write to a run holds that run's lease (fencing tokens, arbitrated across processes by a lock file), so two API
 *     instances never drive the same run: timers and approval timeouts are advanced by whichever instance holds it.
 */

/** This process, as a lease owner. */
const INSTANCE = `api-${hostname()
  .replace(/[^A-Za-z0-9_.-]/g, '_')
  .slice(0, 40)}-${process.pid}-${randomBytes(3).toString('hex')}`;
const LEASE_TTL_MS = 60_000;

export const runsDir = (dataConfig: WorkspaceDataConfig, workspaceId: string, definitionId: string): string =>
  join(dataConfig.dataRootDir, workspaceId, 'generated-runs', definitionId);

export interface RunMeta {
  readonly initiator: EffectCall['initiator'];
  readonly certificateId: string;
  readonly startedAt: string;
  /** UW-2 (ADR 0032): the Workflow entity and version this run belongs to, recorded before the run's first entry. */
  readonly workflow?: { readonly workflowId: string; readonly version: number };
  /** UW-8 (ADR 0046): the batch approval this run was started with; every approval step and call of it is checked against it. */
  readonly batch?: { readonly approvalId: string; readonly previewId: string; readonly root: string };
}

export async function readMeta(dir: string, runId: string): Promise<RunMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'meta', `${runId}.json`), 'utf8')) as RunMeta;
  } catch {
    return undefined;
  }
}

/** For an item run of a `for_each`, the run that fanned it out (whose initiator it acts for). */
async function rootRunId(store: RunStore, runId: string): Promise<string> {
  let id = runId;
  for (let depth = 0; depth < 4; depth++) {
    const first = (await store.read(id).catch(() => []))[0];
    const parent = first?.type === 'run_started' ? (first.data as { parent?: unknown }).parent : undefined;
    if (typeof parent !== 'string') return id;
    id = parent;
  }
  return id;
}

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      if (cause instanceof RunInputError)
        return errorToResponse(new XoError(ErrorCode.INVALID_ARGUMENT, cause.message, { context: { problems: [...cause.problems] } }));
      if (cause instanceof ApprovalError)
        return errorToResponse(new XoError(ErrorCode.INVALID_ARGUMENT, cause.message, { context: { reason: cause.code } }));
      return errorToResponse(cause);
    }
  };
}

/** Asks, immediately before each call, whether it may still be made; a refusal is `DENIED` and nothing is sent. */
export type EffectGate = (call: {
  readonly runId: string;
  readonly stepId: string;
  readonly connector: string;
  readonly operation: string;
  /** UW-8: the call's actual arguments, compared with what a batch approval covered. */
  readonly args: Readonly<Record<string, unknown>>;
}) => Promise<string | undefined>;

export function bridge(
  adapter: ExternalToolAdapter,
  connectorId: string,
  operations: Readonly<Record<string, 'read' | 'write' | 'irreversible'>>,
  gate: EffectGate,
  /** UW-9: the binding's connection credential, offered to the adapter per call (never the secret itself). */
  credential?: (operation: string) => AdapterCredential,
): Connector {
  const ops: Record<string, Connector['operations'][string]> = {};
  for (const [name, sideEffect] of Object.entries(operations))
    ops[name] = {
      sideEffect,
      execute: async (args, ctx) => {
        const refused = await gate({
          runId: ctx.runId,
          stepId: ctx.stepId,
          connector: connectorId,
          operation: name,
          args: args as Record<string, unknown>,
        });
        if (refused !== undefined) throw new ConnectorError('DENIED', `not authorized now: ${refused}`, 'none');
        const r = await adapter.invoke({
          capabilityId: `${connectorId}.${name}`,
          dispatchKey: ctx.idempotencyKey ?? `${ctx.runId}:${ctx.stepId}`,
          input: args,
          ...(credential !== undefined ? { credential: credential(name) } : {}),
        });
        if (r.kind === 'confirmed_success') return (r.output ?? null) as Json;
        // RX-1c: the destination asked to slow down; nothing was done, and the engine tries again after the pause, within the deadline.
        if (r.kind === 'confirmed_failure_no_effect' && /^(rate_limited|too_many_requests)$/i.test(r.code))
          throw new ConnectorError('RATE_LIMITED', `${r.code}: ${r.message}`, 'none', r.retryAfterMs ?? 2_000);
        if (r.kind === 'confirmed_failure_no_effect') throw new ConnectorError('FAILED', `${r.code}: ${r.message}`, 'none');
        throw new ConnectorError('FAILED', `outcome unknown: ${r.reason}`);
      },
    };
  return { kind: 'http', operations: ops };
}

export interface RunnerDeps {
  readonly workspaceStore: WorkspaceStore;
  readonly dataConfig: WorkspaceDataConfig;
  readonly permissionManager: PermissionManager;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly audit?: AuditService;
  /** The lease owner (default: this process). Tests use two to stand for two instances. */
  readonly owner?: string;
}

/**
 * The runner for one generated workflow, with its connectors, its leases and (for a decision) the deciding reviewer.
 * `starting` names who is starting a run in this request: the effects of a run are authorized for the person who started
 * it, read from the run's record afterwards.
 */
export async function runnerFor(
  deps: RunnerDeps,
  workspace: WorkspaceRecord,
  definition: WorkflowDefinitionRecord,
  options: {
    readonly reviewer?: { readonly id: string };
    readonly starting?: { readonly runId: string; readonly meta: RunMeta };
    /** UW-8: a preview runner over this scratch journal (engine preview mode: nothing is ever sent, no lease). */
    readonly preview?: { readonly store: RunStore };
  } = {},
): Promise<WorkflowRunner> {
  const { dataConfig } = deps;
  const reviewer = options.reviewer;
  const component = definition.lowered.component as WorkflowComponent | undefined;
  if (component === undefined)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `generated workflow ${definition.definitionId} has no definition to run`);
  const bindings = (await readConnectorBindings(workspace, dataConfig)).bindings;
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const authorizer = effectAuthorizer({
    workspaceStore: deps.workspaceStore,
    dataConfig,
    permissionManager: deps.permissionManager,
    workspaceId: workspace.workspaceId,
    definition,
  });
  const authority = new LeaseAuthority(join(dir, 'leases'), store, Date.now, { crossProcess: {} });
  const leased = new LeasedRunStore(authority, store);
  // One lease owner per runner: two requests in one process exclude each other exactly as two processes do.
  const owner = `${deps.owner ?? INSTANCE}-${randomBytes(4).toString('hex')}`;
  const keys = await approvalKeyring(dataConfig.dataRootDir, deps.env);
  // RX-1a (ADR 0048): the emergency stops, read again before every call; the engine's kill switch reads the latest view between calls.
  const stops = await EmergencyStops.load(dataConfig.dataRootDir, workspace.workspaceId);
  // UW-8: the batch approval a run was started with (read from the run's record), with its preview, once per runner.
  const batches = new Map<string, Promise<BatchContext | undefined>>();
  const batchOf = (runId: string): Promise<BatchContext | undefined> => {
    let p = batches.get(runId);
    if (p === undefined) {
      p = (async () => {
        const root = await rootRunId(store, runId);
        const meta = options.starting?.runId === root ? options.starting.meta : await readMeta(dir, root);
        if (meta?.batch === undefined) return undefined;
        const bs = new BatchStore(batchDir(dir));
        const [approval, preview] = await Promise.all([bs.getApproval(meta.batch.approvalId), bs.getPreview(meta.batch.previewId)]);
        return { root, approval, preview };
      })();
      batches.set(runId, p);
    }
    return p;
  };
  let identities: Promise<ReadonlyMap<string, string>> | undefined;
  const bindingDigests = (): Promise<ReadonlyMap<string, string>> =>
    (identities ??= bindingIdentities(deps, workspace, component).then((m) => new Map([...m].map(([k, v]) => [k, v.digest]))));
  const implementations: Record<string, Connector> = {};
  const grants: Record<string, { grant: string[] }> = {};
  for (const decl of component.connectors) {
    const b = bindings.find((x) => x.connector === decl.id);
    const adapter = b !== undefined ? adapterFor(dataConfig, workspace, b.adapter) : undefined;
    if (adapter === undefined) continue; // undeclared implementation: the host refuses the call (NO_IMPLEMENTATION), it never guesses
    const ops = Object.fromEntries(decl.operations.map((o) => [o.name, o.sideEffect]));
    const adapterId = b!.adapter;
    const gate: EffectGate = async (call) => {
      const root = await rootRunId(store, call.runId);
      const meta = options.starting?.runId === root ? options.starting.meta : await readMeta(dir, root);
      const stopped = await stops.checkNow({
        definitionId: definition.definitionId,
        ...(meta?.workflow !== undefined ? { workflowId: meta.workflow.workflowId } : {}),
        connector: call.connector,
        operation: call.operation,
      });
      let reason =
        stopped !== undefined
          ? describeHit(stopped)
          : meta === undefined
            ? 'the run has no record of who started it'
            : await authorizer.check({
                stepId: call.stepId,
                connector: call.connector,
                operation: call.operation,
                adapterId,
                initiator: meta.initiator,
              });
      // UW-8: a run started with a batch approval makes exactly the calls that were approved, argument for argument.
      if (reason === undefined && meta?.batch !== undefined)
        reason = await batchCallCheck(await batchOf(call.runId), store, call, bindingDigests);
      if (reason !== undefined)
        await deps.audit?.tryRecord({
          action: 'generated-workflow.effect',
          actor: SYSTEM_ACTOR,
          correlationId: `${call.runId}:${call.stepId}`,
          target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
          type: 'generated-workflow.effect.denied',
          outcome: 'denied',
          reasonCode: 'effect_not_authorized',
          metadata: {
            runId: call.runId,
            step: call.stepId,
            connector: call.connector,
            operation: call.operation,
            reason: reason.slice(0, 300),
          },
        });
      return reason;
    };
    // UW-9: a binding that names a connection credential lends it to the adapter for each call, through the broker: this
    // workspace's credential, active, with the scopes the adapter asks for, refreshed when due. A refusal stops the call before
    // anything is sent.
    const credentialId = b!.credentialId;
    const lend =
      credentialId === undefined
        ? undefined
        : (operation: string): AdapterCredential => ({
            use: async (fn, need) => {
              const config = await (dataConfig.credentials ?? (() => loadCredentialsConfig(dataConfig.dataRootDir, deps.env)))();
              if (config === undefined)
                throw new ConnectorError('DENIED', 'connections are not configured on this instance (XO_CREDENTIALS_KEY)', 'none');
              try {
                return await workspaceBroker(workspace, dataConfig.dataRootDir, config, deps.audit).use(
                  credentialId,
                  { ...(need?.scopes !== undefined ? { scopes: need.scopes } : {}), purpose: `connector:${decl.id}.${operation}` },
                  fn,
                );
              } catch (e) {
                if (e instanceof CredentialError) throw new ConnectorError('DENIED', `the connection cannot be used: ${e.message}`, 'none');
                throw e;
              }
            },
          });
    implementations[decl.id] = { ...bridge(adapter, decl.id, ops, gate, lend), kind: decl.kind };
    grants[decl.id] = { grant: decl.operations.map((o) => o.name) };
  }
  const host = new ConnectorHost({ component, policy: { connectors: grants }, implementations, vault: new MapVault({}) });
  if (options.preview !== undefined)
    return new WorkflowRunner({
      component,
      workflowId: component.workflows[0]!.id,
      store: options.preview.store,
      connectors: host,
      preview: true,
      // Approval steps pass as approved in a preview; the runner still needs the approvals configuration to accept them.
      approvals: { reviewers: new StaticReviewerRegistry([]) },
    });
  return new WorkflowRunner({
    component,
    workflowId: component.workflows[0]!.id,
    store: leased,
    lease: {
      client: authority,
      owner,
      ttlMs: LEASE_TTL_MS,
      attach: (id, token) => leased.attach(id, owner, token),
      detach: (id) => leased.detach(id),
    },
    connectors: host,
    // RX-1c (ADR 0048): per-connector pace from XO_CONNECTOR_RATE_LIMITS, shared by every runner of this workspace, and the pauses
    // providers asked for.
    rateLimits: workspaceRateLimiters(workspace.workspaceId, deps.env),
    // RX-1a: an emergency stop holds the run before its next step, a batch before its next item, and a stopped connector or
    // operation before its call. Released, the run carries on at the next tick. The effect gate above is the backstop.
    hold: async (call) => (await stops.checkNow({ definitionId: definition.definitionId, ...(call ?? {}) })) !== undefined,
    approvals: {
      reviewers: new StaticReviewerRegistry(
        reviewer !== undefined ? [{ id: reviewer.id, roles: ['reviewer'], publicKeyPem: keys.active.publicKeyPem }] : [],
      ),
      // UW-8: an approval step of a run started with a batch approval is decided by that approval, when the preview the person
      // approved showed this item reaching this step. The decision is that person's, signed as theirs; the engine verifies it.
      presigned: async (request) => {
        const b = await batchOf(request.runId);
        if (b === undefined) return undefined;
        const index = await itemIndexOf(store, request.runId);
        const item = b.preview.items.find((i) => i.index === index);
        if (item === undefined || !item.approvals.includes(request.step) || Date.parse(b.approval.payload.expiresAt) < Date.now())
          return undefined;
        const reviewerId = b.approval.payload.reviewerId;
        const decision = signDecision(keys.active.privateKeyPem, {
          v: 1,
          approvalId: request.approvalId,
          runId: request.runId,
          step: request.step,
          action: 'approve',
          edits: {},
          reviewerId,
          at: new Date().toISOString(),
          comment: `batch approval ${b.approval.payload.approvalId}`,
        });
        return { decision, reviewer: { id: reviewerId, roles: ['reviewer'], publicKeyPem: keys.active.publicKeyPem } };
      },
    },
  });
}

/**
 * UW-8: per connector of the definition, a digest of its workspace bindings and of the account its connection sends as, and what to
 * show the reviewer about that sender. A changed binding or a reconnected account changes the digest, so it changes what was approved.
 */
export async function bindingIdentities(
  deps: RunnerDeps,
  workspace: WorkspaceRecord,
  component: WorkflowComponent,
): Promise<Map<string, { readonly digest: string; readonly sender: SenderView }>> {
  const all = (await readConnectorBindings(workspace, deps.dataConfig)).bindings;
  const out = new Map<string, { digest: string; sender: SenderView }>();
  let config: Awaited<ReturnType<typeof loadCredentialsConfig>> | undefined | null = null;
  for (const decl of component.connectors) {
    const bindings = all.filter((b) => b.connector === decl.id);
    if (bindings.length === 0) continue;
    const credentialId = bindings.find((b) => b.credentialId !== undefined)?.credentialId;
    let account: string | undefined;
    let sender: SenderView = { connector: decl.id };
    if (credentialId !== undefined) {
      if (config === null)
        config = await (deps.dataConfig.credentials ?? (() => loadCredentialsConfig(deps.dataConfig.dataRootDir, deps.env)))().catch(
          () => undefined,
        );
      const c =
        config !== undefined
          ? await workspaceBroker(workspace, deps.dataConfig.dataRootDir, config)
              .describe(credentialId)
              .catch(() => undefined)
          : undefined;
      account = c?.accountRef ?? (c?.username !== undefined ? `${c.username}@${c.host ?? ''}` : undefined);
      const label = c?.accountLabel ?? c?.username;
      // UAC-32: for an email binding, the tier it sends in, so the reviewer sees it in the batch preview.
      const tier = c !== undefined && bindings.some((b) => b.adapter === 'email') ? emailTierOf(c) : undefined;
      sender = {
        connector: decl.id,
        credentialId,
        ...(c !== undefined ? { provider: c.provider } : {}),
        ...(label !== undefined ? { account: label } : {}),
        ...(tier !== undefined ? { tier: tier.tier, tierExplanation: tier.explanation } : {}),
      };
    }
    const digest = digestOfJson({
      bindings: [...bindings].sort((a, b) => a.operation.localeCompare(b.operation)),
      account: account ?? null,
    });
    out.set(decl.id, { digest, sender });
  }
  return out;
}

interface BatchContext {
  readonly root: string;
  readonly approval: BatchApprovalRecord;
  readonly preview: PreviewRecord;
}

/** Which item of its batch a run is (a run that is not an item is item 0 of a batch of one). */
async function itemIndexOf(store: RunStore, runId: string): Promise<number> {
  if (!runId.startsWith('fe_')) return 0;
  const first = (await store.read(runId))[0];
  const i = (first?.data as { index?: unknown } | undefined)?.index;
  return typeof i === 'number' ? i : -1;
}

/**
 * UW-8: immediately before a call of a batch-approved run, the call must be one the approved preview showed for this item, with the
 * same connector, operation, binding (so the same sending account) and argument digest. Anything else is refused and nothing is sent.
 */
async function batchCallCheck(
  b: BatchContext | undefined,
  store: RunStore,
  call: Parameters<EffectGate>[0],
  bindingDigests: () => Promise<ReadonlyMap<string, string>>,
): Promise<string | undefined> {
  if (b === undefined) return 'the batch approval this run was started with cannot be read';
  if (Date.parse(b.approval.payload.expiresAt) < Date.now()) return 'the batch approval expired before this call';
  const index = await itemIndexOf(store, call.runId);
  const item = b.preview.items.find((i) => i.index === index);
  const approved = item?.actions.filter((x) => x.step === call.stepId) ?? [];
  if (approved.length === 0) return `item ${index} was not approved to make a call at step "${call.stepId}"`;
  const binding = (await bindingDigests()).get(call.connector) ?? 'unbound';
  const now = actionDigest({
    step: call.stepId,
    connector: call.connector,
    operation: call.operation,
    sideEffect: approved[0]!.sideEffect,
    binding,
    argsDigest: digestOfJson(call.args),
  });
  if (approved.some((x) => x.digest === now)) return undefined;
  return `item ${index}: this call differs from what was approved (a recipient, attachment, message, sender or setting changed)`;
}

export async function view(
  runner: WorkflowRunner,
  runId: string,
  dir: string,
  dataRootDir: string,
  /** RX-1a: when given, a stop on any connector or operation it declares is reported as holding the run. */
  component?: WorkflowComponent,
): Promise<Record<string, unknown>> {
  // A due timer or an expired approval on THIS run advances now (under its lease); another instance holding it is fine.
  const before = await runner.status(runId);
  // A run left `running` (an emergency stop held it, or its process ended) carries on when read, as a waiting one does; a run another
  // request is driving holds its lease, so this is a no-op there.
  if (before.state === 'waiting' || before.state === 'running')
    await runner.resume(runId).catch((e: unknown) => (e instanceof LeaseError ? undefined : Promise.reject(e)));
  const status = await runner.status(runId);
  const pending = (await runner.listApprovals()).filter((a) => a.runId === runId);
  // Every journaled decision is re-verified against the keyring: which key signed it, or that none does.
  const keys = await currentPublicKeys(dataRootDir);
  const entries = await new RunStore(dir).read(runId);
  const decisions = entries
    // UW-8: a decision presented from a batch approval is journaled as `approval_presigned`; it is shown and re-verified the same way.
    .filter((e) => e.type === 'approval_decided' || e.type === 'approval_presigned')
    .map((e) => {
      const d = e.data as { step: string; reviewerId: string; action: string; payload: Record<string, unknown>; signature: string };
      const keyId = verifyJournaledDecision(d.payload, d.signature, keys);
      return {
        step: d.step,
        reviewerId: d.reviewerId,
        action: d.action,
        at: d.payload['at'],
        signatureVerified: keyId !== undefined,
        ...(keyId !== undefined ? { keyId } : {}),
      };
    });
  const meta = await readMeta(dir, runId);
  // RX-1a: a run in progress that an emergency stop holds says so (runsDir is <data>/<workspace>/generated-runs/<definition>).
  let held: string | undefined;
  if (status.state === 'running' || status.state === 'waiting') {
    const stops = await EmergencyStops.load(dataRootDir, basename(dirname(dirname(dir))));
    const hit =
      stops.check({
        definitionId: basename(dir),
        ...(meta?.workflow !== undefined ? { workflowId: meta.workflow.workflowId } : {}),
      }) ??
      (component?.connectors ?? [])
        .flatMap((c) => c.operations.map((o) => stops.check({ connector: c.id, operation: o.name })))
        .find((h) => h !== undefined);
    if (hit !== undefined) held = describeHit(hit);
  }
  return {
    ...status,
    ...(held !== undefined ? { held } : {}),
    pendingApprovals: pending,
    decisions,
    // UW-7 (ADR 0033, UAC-9): every external call of this run in the one effect vocabulary.
    effects: effectsOf(entries),
    ...(meta !== undefined ? { startedBy: meta.initiator.id, startedAt: meta.startedAt } : {}),
    ...(meta?.workflow !== undefined ? { workflow: meta.workflow } : {}),
  };
}

/** UW-2: a run that belongs to a Workflow entity tells the workspace change feed that it moved. */
async function publishRunChange(
  dataConfig: WorkspaceDataConfig,
  workspaceId: string,
  meta: RunMeta | undefined,
  runId: string,
  state: string,
): Promise<void> {
  if (meta?.workflow === undefined) return;
  await workspaceWorkflowEntitiesStore(dataConfig.dataRootDir, workspaceId).publish({
    at: new Date().toISOString(),
    workflowId: meta.workflow.workflowId,
    kind: 'run',
    runId,
    state,
  });
}

export interface StartGeneratedRun {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly input: Record<string, unknown>;
  readonly certificateId: unknown;
  readonly idempotencyKey?: unknown;
  readonly correlationId: string;
  readonly workflow?: { readonly workflowId: string; readonly version: number };
  /** UW-8: the batch approval to start with (required for a run with effects when XO_RUN_APPROVAL is `required`). */
  readonly batchApprovalId?: unknown;
}

/**
 * Starts a generated workflow as Workflow IR: the certificate gate, the workspace pause, the run id, the durable record of who
 * started it (and, for a Workflow entity, which workflow and version) before the first journal entry, then the run. Shared by
 * the generated-workflow route and the Workflow entity route, so both enforce exactly the same gates.
 */
export async function startGeneratedRun(
  deps: RunnerDeps,
  s: StartGeneratedRun,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const { workspace, actor, definition, audit } = { ...s, audit: deps.audit };
  const { dataConfig } = deps;
  const draft = {
    action: 'generated-workflow.run',
    actor: actorFromPrincipal(actor),
    correlationId: s.correlationId,
    target: { kind: 'workflow' as const, id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
  };
  const certificateId = await requireStartable(deps, workspace, definition, s.certificateId, draft, s.workflow?.workflowId);
  // UW-8 (ADR 0046): a run with effects starts with a person's batch approval over its exact preview (required in production).
  const component = definition.lowered.component as WorkflowComponent | undefined;
  let input = s.input;
  let batch: RunMeta['batch'] | undefined;
  let batchRunId: string | undefined;
  if (s.batchApprovalId !== undefined) {
    const v = await verifyBatchForStart(deps, {
      workspace,
      definition,
      certificateId,
      input: s.input,
      approvalId: s.batchApprovalId,
      actor,
      draft,
    });
    ({ input, batch, runId: batchRunId } = v);
  } else if (dataConfig.preExecution?.runApproval === 'required' && component !== undefined && hasEffects(component)) {
    await audit?.tryRecord({
      ...draft,
      type: 'generated-workflow.batch.required',
      outcome: 'denied',
      reasonCode: 'batch_approval_required',
    });
    throw new XoError(
      ErrorCode.BATCH_APPROVAL_REQUIRED,
      "this workflow can send or change things, so it starts only with a person's approval of exactly what it will do: prepare a preview (POST …/previews), have it approved, and start with its batchApprovalId",
    );
  }
  const idem = s.idempotencyKey;
  // The run id is fixed before the run starts, so who started it is on record before its first effect. A run started for a
  // Workflow entity also binds the entity into the id, so one key on two workflows that share a definition are two runs.
  const scope = s.workflow !== undefined ? `\u0000${s.workflow.workflowId}` : '';
  const runId =
    batchRunId ??
    (typeof idem === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(idem)
      ? `run_${createHash('sha256').update(`${definition.definitionId}\u0000${actor.id}\u0000${idem}${scope}`).digest('hex').slice(0, 32)}`
      : `run_${randomBytes(16).toString('hex')}`);
  const meta: RunMeta = {
    initiator: { kind: actor.kind, id: actor.id },
    certificateId,
    startedAt: new Date().toISOString(),
    ...(s.workflow !== undefined ? { workflow: { workflowId: s.workflow.workflowId, version: s.workflow.version } } : {}),
    ...(batch !== undefined ? { batch } : {}),
  };
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  await mkdir(join(dir, 'meta'), { recursive: true });
  await writeFile(join(dir, 'meta', `${runId}.json`), JSON.stringify(meta), { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e; // a retry of the same request: the first record stands
  });
  const stored = (await readMeta(dir, runId)) ?? meta;
  if (s.workflow !== undefined && stored.workflow?.workflowId !== s.workflow.workflowId)
    throw new XoError(ErrorCode.ALREADY_EXISTS, `run ${runId} already exists for another workflow; use another Idempotency-Key`);
  // RX-1b (ADR 0048): what this run is bound to, in one place, before its first journal entry (a retry keeps the first).
  if (component !== undefined) {
    const cert = await workspaceCertificatesStore(workspace, dataConfig).get(certificateId);
    const identities = await bindingIdentities(deps, workspace, component);
    await writeManifest(dir, {
      v: 1,
      runId,
      workspaceId: workspace.workspaceId,
      definitionId: definition.definitionId,
      workflowName: definition.workflowName,
      compilationId: definition.compilationId,
      componentSha256: componentSha256(component),
      ...(stored.workflow !== undefined ? { workflow: stored.workflow } : {}),
      certificate: { certificateId, digest: String(cert.digest) },
      bindings: Object.fromEntries([...identities].map(([k, v]) => [k, v.digest])),
      inputDigest: digestOfJson(input),
      ...(stored.batch !== undefined ? { batch: stored.batch } : {}),
      // RX-1d: the packs the certificate pinned (verified unchanged at admission, just above).
      packs: cert.bindings.packs ?? [],
      initiator: stored.initiator,
      admittedAt: stored.startedAt,
    });
  }
  const runner = await runnerFor(deps, workspace, definition, { starting: { runId, meta: stored } });
  let result: RunResult;
  try {
    result = await runner.start({ inputs: input, runId });
  } catch (e) {
    // The same run is being started or driven by another request right now (a retried start, the same Idempotency-Key, or the
    // same batch approval twice): it is one run, so answer with where it stands instead of failing (UW-8).
    if (!(e instanceof LeaseError && e.code === 'HELD')) throw e;
    // The other request may hold the lease a moment before it writes the run's first entry: wait for the run to exist.
    let status: Awaited<ReturnType<typeof runner.status>> | undefined;
    for (let attempt = 0; status === undefined; attempt++) {
      try {
        status = await runner.status(runId);
      } catch (cause) {
        if (attempt >= 100) throw cause;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    result = { ...status, accepted: false };
  }
  await audit?.tryRecord({
    ...draft,
    type: 'generated-workflow.run.started',
    outcome: 'completed',
    metadata: {
      runId: result.runId,
      certificateId,
      state: result.state,
      ...(batch !== undefined ? { batchApprovalId: batch.approvalId } : {}),
      ...(stored.workflow !== undefined ? { workflowEntityId: stored.workflow.workflowId, workflowVersion: stored.workflow.version } : {}),
    },
  });
  await publishRunChange(dataConfig, workspace.workspaceId, stored, result.runId, result.state);
  return {
    status: result.accepted ? 201 : 200,
    body: { ...(await view(runner, result.runId, dir, dataConfig.dataRootDir)), certificateId },
  };
}

/** The gates every start (and every preview) passes: a current certificate for this definition, the workspace not paused, no drift. */
async function requireStartable(
  deps: RunnerDeps,
  workspace: WorkspaceRecord,
  definition: WorkflowDefinitionRecord,
  certificateId: unknown,
  draft: Omit<Parameters<AuditService['tryRecord']>[0], 'type' | 'outcome'>,
  /** RX-1a: the Workflow entity this start is for, when it is one (a stop on the entity holds it). */
  workflowId?: string,
): Promise<string> {
  const { dataConfig } = deps;
  const audit = deps.audit;
  if (typeof certificateId !== 'string') {
    await audit?.tryRecord({ ...draft, type: 'readiness.start.refused', outcome: 'denied', reasonCode: 'certificate_required' });
    throw new XoError(
      ErrorCode.READINESS_CERTIFICATE_REQUIRED,
      'a generated workflow runs only with a current readiness certificate: request one and pass its certificateId',
    );
  }
  const cert = await workspaceCertificatesStore(workspace, dataConfig).get(certificateId);
  const reasons: string[] = [];
  if (cert.scope.definitionId !== definition.definitionId) reasons.push(`certificate ${certificateId} is for another generated workflow`);
  else {
    const v = await verifyCertificateNow(workspace, dataConfig, cert);
    if (!v.ok) reasons.push(...v.reasons);
  }
  if (reasons.length > 0) {
    await audit?.tryRecord({
      ...draft,
      type: 'readiness.start.refused',
      outcome: 'denied',
      reasonCode: 'certificate_refused',
      metadata: { certificateId },
    });
    throw new XoError(
      ErrorCode.READINESS_CERTIFICATE_REFUSED,
      `the readiness certificate does not allow this start: ${reasons.join('; ')}`,
      { context: { certificateId, reasons } },
    );
  }
  await enforceNotPaused(new FsControlsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId));
  // RX-1a (ADR 0048): an emergency stop on the instance, this workflow, or a connector or operation it can call holds the start.
  try {
    await enforceNoEmergencyStop(dataConfig.dataRootDir, workspace.workspaceId, {
      definitionId: definition.definitionId,
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(definition.lowered.component !== undefined ? { component: definition.lowered.component as WorkflowComponent } : {}),
    });
  } catch (e) {
    if (e instanceof StartRefusedError)
      await audit?.tryRecord({ ...draft, type: 'emergency-stop.refused', outcome: 'denied', reasonCode: 'emergency_stop' });
    throw e;
  }
  // UW-15 (UAC-34): the data must still have the shape this workflow was compiled for. A used column renamed, removed or retyped, or
  // reformatted, stops the run HERE, before a run record or any effect exists, with the differences in the error.
  const drift = await checkDataDrift(workspace, dataConfig, definition.compilationId, definition.dataReads ?? []);
  if (drift.status === 'blocking') {
    await audit?.tryRecord({
      ...draft,
      type: 'generated-workflow.drift.refused',
      outcome: 'denied',
      reasonCode: 'data_schema_drift',
      metadata: {
        sources: drift.sources.filter((x) => x.status === 'blocking').length,
        differences: drift.sources.reduce(
          (n, x) => n + x.tables.reduce((m, t) => m + t.report.differences.filter((d) => d.severity === 'blocking').length, 0),
          0,
        ),
      },
    });
    throw new XoError(ErrorCode.DATA_SCHEMA_DRIFT, driftSummary(drift), { context: { report: drift } });
  }
  return certificateId;
}

// ------------------------------------------------------------------------------------------------ UW-8 batch preview and approval

type AuditDraft = Omit<Parameters<AuditService['tryRecord']>[0], 'type' | 'outcome'>;

/**
 * Runs the definition over this input in the engine's preview mode (nothing is sent) in a scratch journal, and builds the preview:
 * each item's exact calls, one leaf per item, one root. The scratch journal is removed afterwards.
 */
async function computePreview(
  deps: RunnerDeps,
  workspace: WorkspaceRecord,
  definition: WorkflowDefinitionRecord,
  input: Record<string, unknown>,
  certificateId: string,
  createdBy: string,
  previewId?: string,
): Promise<PreviewRecord> {
  const component = definition.lowered.component as WorkflowComponent | undefined;
  if (component === undefined)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `generated workflow ${definition.definitionId} has no definition to run`);
  const dir = runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId);
  const scratch = join(batchDir(dir), 'scratch', randomBytes(8).toString('hex'));
  await mkdir(scratch, { recursive: true });
  try {
    const store = new RunStore(scratch);
    const runner = await runnerFor(deps, workspace, definition, { preview: { store } });
    const runId = `run_${randomBytes(16).toString('hex')}`;
    await runner.start({ inputs: input, runId });
    return await buildPreview({
      component,
      definitionId: definition.definitionId,
      certificateId,
      input,
      store,
      runId,
      bindings: await bindingIdentities(deps, workspace, component),
      createdBy,
      now: new Date(),
      ...(previewId !== undefined ? { previewId } : {}),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface PreviewGeneratedRun {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly input: Record<string, unknown>;
  readonly certificateId: unknown;
  readonly correlationId: string;
  /** V1-1 (ADR 0049): build the items from this confirmed list or pairing. */
  readonly items?: ItemSourceRef;
}

const SHOWN_EXCLUSIONS = 200;

/** The fields of an item the workflow reads (`item.<field>` in an input or a template). */
export function itemFieldsUsed(component: WorkflowComponent): string[] {
  const text = JSON.stringify(component.workflows);
  const out = new Set<string>();
  for (const m of text.matchAll(/"from":"item\.([a-z][a-z0-9_]{0,63})"|\{\{\s*item\.([a-z][a-z0-9_]{0,63})\s*\}\}/g))
    out.add(m[1] ?? m[2]!);
  return [...out].sort();
}

/** The input a forEach workflow gets from a confirmed source, and the record of where its items came from. */
async function inputFromSource(
  deps: RunnerDeps,
  workspace: WorkspaceRecord,
  definition: WorkflowDefinitionRecord,
  input: Record<string, unknown>,
  ref: ItemSourceRef,
): Promise<{ input: Record<string, unknown>; itemsSource: PreviewItemsSource }> {
  const component = definition.lowered.component as WorkflowComponent | undefined;
  const over = component?.workflows[0]?.forEach?.over;
  if (component === undefined || over === undefined)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'this workflow does not run once per item, so it takes no "items"');
  if (Object.hasOwn(input, over))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `give the items either as "items" or as input "${over}", not both`);
  const built = await itemsFromConfirmedSource({ workspace, dataConfig: deps.dataConfig }, ref);
  const missing = itemFieldsUsed(component).filter((f) => !built.fields.includes(f));
  if (missing.length > 0)
    throw new XoError(
      ErrorCode.PRECONDITION_FAILED,
      `"${built.source.label}" gives no ${missing.map((f) => `"${f}"`).join(', ')}, which this workflow reads for each item; its items have ${built.fields.map((f) => `"${f}"`).join(', ')}`,
      { context: { missingFields: missing, fields: built.fields } },
    );
  if (built.items.length === 0)
    throw new XoError(
      ErrorCode.PRECONDITION_FAILED,
      `"${built.source.label}" gives no items now (${built.excludedRows.length} row(s) left out)`,
      {
        context: { excludedRows: built.excludedRows.slice(0, SHOWN_EXCLUSIONS) },
      },
    );
  return {
    input: { ...input, [over]: built.items },
    itemsSource: {
      ...built.source,
      over,
      counts: {
        items: built.items.length,
        excludedRows: built.excludedRows.length,
        excludedDocuments: built.excludedDocuments.length,
        loose: built.looseRows.length,
      },
      excludedRows: built.excludedRows.slice(0, SHOWN_EXCLUSIONS),
      excludedDocuments: built.excludedDocuments.slice(0, SHOWN_EXCLUSIONS),
      looseRows: built.looseRows.slice(0, SHOWN_EXCLUSIONS),
    },
  };
}

/** UW-8: prepares a batch preview (author role). The same gates as a start apply; nothing is sent. */
export async function previewGeneratedRun(deps: RunnerDeps, p: PreviewGeneratedRun): Promise<Record<string, unknown>> {
  const { workspace, actor, definition } = p;
  const draft: AuditDraft = {
    action: 'generated-workflow.batch',
    actor: actorFromPrincipal(actor),
    correlationId: p.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
  };
  const certificateId = await requireStartable(deps, workspace, definition, p.certificateId, draft);
  const fromSource = p.items !== undefined ? await inputFromSource(deps, workspace, definition, p.input, p.items) : undefined;
  const computed = await computePreview(deps, workspace, definition, fromSource?.input ?? p.input, certificateId, actor.id);
  const preview: PreviewRecord = fromSource !== undefined ? { ...computed, itemsSource: fromSource.itemsSource } : computed;
  await new BatchStore(batchDir(runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId))).putPreview(preview);
  await deps.audit?.tryRecord({
    ...draft,
    type: 'generated-workflow.batch.previewed',
    outcome: 'completed',
    metadata: {
      previewId: preview.previewId,
      items: preview.items.length,
      ...preview.counts,
      ...(preview.itemsSource !== undefined
        ? { itemsFrom: preview.itemsSource.proposalId, excludedRows: preview.itemsSource.counts.excludedRows }
        : {}),
    },
  });
  return previewView(preview, undefined, undefined, {});
}

/** One page of a preview, exceptions first (or only the exceptions), with its approval and use if any. */
export function previewView(
  p: PreviewRecord,
  approval: BatchApprovalRecord | undefined,
  used: { readonly runId: string } | undefined,
  q: { readonly page?: number; readonly size?: number; readonly show?: string },
): Record<string, unknown> {
  const size = Math.min(Math.max(q.size ?? 50, 1), 200);
  const ordered = exceptionsFirst(p.items).filter((i) => q.show !== 'exceptions' || i.state === 'stops' || i.state === 'not_exact');
  const pages = Math.max(1, Math.ceil(ordered.length / size));
  const page = Math.min(Math.max(q.page ?? 1, 1), pages);
  return {
    previewId: p.previewId,
    definitionId: p.definitionId,
    certificateId: p.certificateId,
    root: p.root,
    forEach: p.forEach,
    effects: p.effects,
    counts: p.counts,
    senders: p.senders,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    ...(p.itemsSource !== undefined ? { itemsSource: p.itemsSource } : {}),
    approvable: p.counts.not_exact === 0 && Date.parse(p.expiresAt) > Date.now() && approval === undefined,
    ...(approval !== undefined
      ? {
          approval: {
            approvalId: approval.payload.approvalId,
            reviewerId: approval.payload.reviewerId,
            approvedAt: approval.payload.at,
            expiresAt: approval.payload.expiresAt,
            ...(used !== undefined ? { usedBy: used.runId } : {}),
          },
        }
      : {}),
    page,
    pages,
    total: ordered.length,
    items: ordered.slice((page - 1) * size, page * size).map((i) => ({
      index: i.index,
      state: i.state,
      ...(i.reason !== undefined ? { reason: i.reason } : {}),
      approvals: i.approvals,
      actions: i.actions.map((x) => ({
        step: x.step,
        connector: x.connector,
        operation: x.operation,
        sideEffect: x.sideEffect,
        args: x.args,
      })),
    })),
  };
}

export interface ApproveBatchPreview {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly previewId: string;
  readonly root: unknown;
  readonly correlationId: string;
}

/**
 * UW-8: a person approves the preview they were shown, named by its root. Callers check the review role and a recent sign-in first.
 * Refused when the root differs, the preview expired or has items that cannot be shown exactly, it was already approved, or (with
 * separation required) the approver prepared it.
 */
export async function approveBatchPreview(deps: RunnerDeps, a: ApproveBatchPreview): Promise<Record<string, unknown>> {
  const { workspace, actor, definition } = a;
  const dir = runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId);
  const bs = new BatchStore(batchDir(dir));
  const preview = await bs.getPreview(a.previewId);
  const draft: AuditDraft = {
    action: 'generated-workflow.batch',
    actor: actorFromPrincipal(actor),
    correlationId: a.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
  };
  const refuse = async (code: string, message: string): Promise<never> => {
    await deps.audit?.tryRecord({
      ...draft,
      type: 'generated-workflow.batch.refused',
      outcome: 'denied',
      reasonCode: code,
      metadata: { previewId: preview.previewId },
    });
    throw new XoError(ErrorCode.BATCH_APPROVAL_REFUSED, message, { context: { reason: code } });
  };
  if (preview.definitionId !== definition.definitionId) throw new NotFoundError(`batch preview "${a.previewId}"`);
  if (typeof a.root !== 'string' || a.root !== preview.root)
    return refuse(
      'root_mismatch',
      'this is not the preview you were shown (its root differs); review the current preview and approve that',
    );
  if (Date.parse(preview.expiresAt) <= Date.now()) return refuse('preview_expired', 'this preview expired; prepare a new one');
  if (preview.counts.not_exact > 0)
    return refuse('not_exact', `${preview.counts.not_exact} item(s) cannot be shown exactly, so they cannot be approved as a batch`);
  if (deps.dataConfig.preExecution?.approvalSeparation === 'required' && actor.id === preview.createdBy)
    return refuse('separation_of_duties', 'someone other than the person who prepared this batch must approve it');
  const keys = await approvalKeyring(deps.dataConfig.dataRootDir, deps.env);
  const at = new Date();
  const payload: BatchApprovalPayload = {
    v: 1,
    kind: 'batch',
    approvalId: newBatchApprovalId(),
    previewId: preview.previewId,
    root: preview.root,
    definitionId: definition.definitionId,
    certificateId: preview.certificateId,
    inputDigest: preview.inputDigest,
    items: preview.items.length,
    reviewerId: actor.id,
    at: at.toISOString(),
    expiresAt: preview.expiresAt,
  };
  const record = signBatchApproval(payload, keys.active);
  await bs.putApproval(record);
  await bs.indexApproval(payload.approvalId, preview.previewId);
  await deps.audit?.tryRecord({
    ...draft,
    type: 'generated-workflow.batch.approved',
    outcome: 'completed',
    metadata: { previewId: preview.previewId, approvalId: payload.approvalId, items: payload.items, sends: preview.counts.sends },
  });
  return previewView(preview, record, undefined, {});
}

/**
 * UW-8: the checks a start with a batch approval passes. The approval verifies under the keyring, is for this definition and
 * certificate, is unexpired and unused; the input is the approved one; and the preview computed NOW gives the same root (any change
 * to a recipient, attachment, message, sender or setting since the approval changes it). The run id follows from the approval, so a
 * retried start is the same run; the approval is consumed exactly once.
 */
async function verifyBatchForStart(
  deps: RunnerDeps,
  v: {
    readonly workspace: WorkspaceRecord;
    readonly definition: WorkflowDefinitionRecord;
    readonly certificateId: string;
    readonly input: Record<string, unknown>;
    readonly approvalId: unknown;
    readonly actor: AuthenticatedPrincipal;
    readonly draft: AuditDraft;
  },
): Promise<{ input: Record<string, unknown>; batch: NonNullable<RunMeta['batch']>; runId: string }> {
  const { workspace, definition } = v;
  const refuse = async (code: string, message: string, context: Record<string, unknown> = {}): Promise<never> => {
    await deps.audit?.tryRecord({ ...v.draft, type: 'generated-workflow.batch.refused', outcome: 'denied', reasonCode: code });
    throw new XoError(ErrorCode.BATCH_APPROVAL_REFUSED, message, { context: { reason: code, ...context } });
  };
  if (typeof v.approvalId !== 'string') return refuse('invalid', 'batchApprovalId must be a string');
  const bs = new BatchStore(batchDir(runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId)));
  const approval = await bs.getApproval(v.approvalId);
  const p = approval.payload;
  if (
    verifyJournaledDecision(
      p as unknown as Record<string, unknown>,
      approval.signature,
      await currentPublicKeys(deps.dataConfig.dataRootDir),
    ) === undefined
  )
    return refuse('signature', 'the batch approval does not verify under the approval keyring');
  if (p.definitionId !== definition.definitionId || p.certificateId !== v.certificateId)
    return refuse('scope', 'the batch approval is for another workflow definition or certificate');
  if (Date.parse(p.expiresAt) <= Date.now()) return refuse('expired', 'the batch approval expired; prepare and approve a new preview');
  const preview = await bs.getPreview(p.previewId);
  const given = Object.keys(v.input).length > 0;
  if (given && digestOfJson(v.input) !== p.inputDigest) return refuse('input_changed', 'the input differs from the one that was approved');
  let input = given ? v.input : (preview.input as Record<string, unknown>);
  // V1-1 (ADR 0049): items built from a confirmed source are built again now, from the files as they are; a changed list or
  // document, or a pairing no longer confirmed, means the approved batch is not what would run.
  const src = preview.itemsSource;
  if (src !== undefined) {
    const { [src.over]: _approved, ...rest } = input;
    let rebuilt: Awaited<ReturnType<typeof inputFromSource>>;
    try {
      rebuilt = await inputFromSource(deps, workspace, definition, rest, { connectionId: src.connectionId, proposalId: src.proposalId });
    } catch (e) {
      if (!(e instanceof XoError)) throw e;
      return refuse('source_unavailable', `the items cannot be built again from "${src.label}": ${e.message}`);
    }
    if (digestOfJson(rebuilt.input) !== p.inputDigest)
      return refuse(
        'source_changed',
        `"${src.label}" in ${src.connectionName} changed since the batch was approved; prepare and approve a new preview`,
      );
    input = rebuilt.input;
  }
  const runId = `run_${createHash('sha256').update(`batch\u0000${p.approvalId}`).digest('hex').slice(0, 32)}`;
  const prior = await bs.consumedBy(p.approvalId);
  if (prior !== undefined && prior.runId !== runId) return refuse('used', `the batch approval was already used for run ${prior.runId}`);
  const now = await computePreview(deps, workspace, definition, input, v.certificateId, preview.createdBy, preview.previewId);
  if (now.root !== p.root) {
    const was = new Map(preview.items.map((i) => [i.index, i.leaf]));
    const changed = now.items.filter((i) => was.get(i.index) !== i.leaf).map((i) => i.index);
    if (now.items.length !== preview.items.length)
      changed.push(...preview.items.filter((i) => i.index >= now.items.length).map((i) => i.index));
    return refuse(
      'changed',
      `what this run would do has changed since it was approved (${changed.length} item(s)); prepare and approve a new preview`,
      { changedItems: changed.slice(0, 50) },
    );
  }
  await bs.consume(p.approvalId, runId, v.actor.id);
  return { input, batch: { approvalId: p.approvalId, previewId: p.previewId, root: p.root }, runId };
}

const RUN_REF = /^(run|fe)_[0-9a-f]{32,40}$/;

/**
 * How an audit event names a run. An item of a batch (`fe_` + 40 hex) is named by its batch's run id and its index: the audit
 * refuses long opaque values in metadata, and the pair is what a person needs to find it.
 */
async function auditRunRef(store: RunStore, runId: string): Promise<Record<string, string | number>> {
  if (!runId.startsWith('fe_')) return { runId };
  const first = (await store.read(runId).catch(() => []))[0];
  const d = (first?.data ?? {}) as { parent?: unknown; index?: unknown };
  return typeof d.parent === 'string' && typeof d.index === 'number' ? { runId: d.parent, item: d.index } : {};
}

export interface CancelGeneratedRun {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly runId: string;
  readonly reason: unknown;
  readonly correlationId: string;
  /** For the entity route: the run must belong to this workflow. */
  readonly workflowId?: string;
}

/**
 * ADR 0024 — cancels a run or a whole batch (or one item of a batch). The request is recorded durably before anything else; no
 * dispatch starts after it; work already settled stands; a call in flight becomes an unknown outcome for a person; a repeat changes
 * nothing. When another instance is driving the run, it applies the request before its next step or call (`applied: false` here).
 * Audited every time, a repeat included.
 */
export async function cancelGeneratedRun(deps: RunnerDeps, c: CancelGeneratedRun): Promise<Record<string, unknown>> {
  const { workspace, actor, definition, runId } = c;
  const { dataConfig } = deps;
  if (!RUN_REF.test(runId)) throw new NotFoundError(`run "${runId}"`);
  if (c.reason !== undefined && (typeof c.reason !== 'string' || c.reason.length > 500))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'reason must be a string of at most 500 characters');
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const root = await rootRunId(store, runId);
  const meta = await readMeta(dir, root);
  if ((await store.read(runId).catch(() => [])).length === 0) throw new NotFoundError(`run "${runId}"`);
  if (c.workflowId !== undefined && meta?.workflow?.workflowId !== c.workflowId)
    throw new NotFoundError(`run "${runId}" of workflow "${c.workflowId}"`);
  const runner = await runnerFor(deps, workspace, definition);
  const result = await runner.cancel(runId, {
    by: actor.id,
    ...(typeof c.reason === 'string' && c.reason.trim() !== '' ? { reason: c.reason.trim() } : {}),
  });
  await deps.audit?.tryRecord({
    action: 'generated-workflow.cancel',
    actor: actorFromPrincipal(actor),
    correlationId: c.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    type: 'generated-workflow.run.cancelled',
    outcome: 'completed',
    metadata: {
      ...(await auditRunRef(store, runId)),
      state: result.state,
      recorded: result.recorded,
      applied: result.cancellation?.applied === true,
      ...(meta?.workflow !== undefined ? { workflowEntityId: meta.workflow.workflowId } : {}),
    },
  });
  await publishRunChange(dataConfig, workspace.workspaceId, meta, runId, result.state);
  return { ...(await view(runner, runId, dir, dataConfig.dataRootDir)), cancelRecorded: result.recorded };
}

export interface ReconcileGeneratedEffect {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly runId: string;
  readonly step: string;
  readonly decision: unknown;
  readonly reason: unknown;
  readonly evidenceExamined: unknown;
  readonly correlationId: string;
  readonly workflowId?: string;
}

/**
 * A person records what happened to a call whose outcome is unknown (UAC-8). Nothing is sent, re-sent or undone. Callers check
 * the review role and a recent sign-in first.
 */
export async function reconcileGeneratedEffect(deps: RunnerDeps, r: ReconcileGeneratedEffect): Promise<Record<string, unknown>> {
  const { workspace, actor, definition, runId, step } = r;
  const { dataConfig } = deps;
  if (!RUN_REF.test(runId)) throw new NotFoundError(`run "${runId}"`);
  const decision = r.decision;
  if (decision !== 'confirmed_success' && decision !== 'confirmed_failure_no_effect' && decision !== 'unresolved')
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'decision must be confirmed_success, confirmed_failure_no_effect or unresolved');
  if (typeof r.reason !== 'string' || r.reason.trim().length === 0 || r.reason.length > 1000)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'reason (what you checked and found) is required, at most 1000 characters');
  if (r.evidenceExamined !== undefined && (typeof r.evidenceExamined !== 'string' || r.evidenceExamined.length > 1000))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'evidenceExamined must be a string of at most 1000 characters');
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const entries = await store.read(runId).catch(() => []);
  if (entries.length === 0) throw new NotFoundError(`run "${runId}"`);
  const meta = await readMeta(dir, await rootRunId(store, runId));
  if (r.workflowId !== undefined && meta?.workflow?.workflowId !== r.workflowId)
    throw new NotFoundError(`run "${runId}" of workflow "${r.workflowId}"`);
  const current = effectsOf(entries).find((e) => e.step === step);
  if (current === undefined) throw new NotFoundError(`an external call of step "${step}" on run "${runId}"`);
  if (current.state !== 'outcome_unknown' && current.state !== 'reconciliation_required')
    throw new XoError(
      ErrorCode.PRECONDITION_FAILED,
      `the call of step "${step}" is ${current.state}; only an unknown outcome is reconciled`,
      {
        context: { state: current.state },
      },
    );
  const runner = await runnerFor(deps, workspace, definition);
  const effect = await runner.recordReconciliation(runId, step, {
    decision,
    by: actor.id,
    reason: r.reason.trim(),
    ...(typeof r.evidenceExamined === 'string' ? { evidenceExamined: r.evidenceExamined } : {}),
  });
  await deps.audit?.tryRecord({
    action: 'generated-workflow.reconcile',
    actor: actorFromPrincipal(actor),
    correlationId: r.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    type: 'generated-workflow.effect.reconciled',
    outcome: 'completed',
    metadata: {
      ...(await auditRunRef(store, runId)),
      step,
      decision,
      state: effect.state,
      ...(meta?.workflow !== undefined ? { workflowEntityId: meta.workflow.workflowId } : {}),
    },
  });
  await publishRunChange(dataConfig, workspace.workspaceId, meta, runId, effect.state);
  return { runId, effect };
}

export interface DecideGeneratedApproval {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly runId: string;
  readonly approvalId: string;
  readonly action: unknown;
  readonly comment: unknown;
  readonly correlationId: string;
  /** For the entity route: the decision must be on a run of this workflow. */
  readonly workflowId?: string;
}

/** A person decides a human step; the platform signs the decision as theirs. Callers check role and recent sign-in first. */
export async function decideGeneratedApproval(deps: RunnerDeps, d: DecideGeneratedApproval): Promise<Record<string, unknown>> {
  const { workspace, actor, definition, runId, approvalId } = d;
  const { dataConfig } = deps;
  const action = d.action;
  if (action !== 'approve' && action !== 'reject')
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'action must be "approve" (done as instructed) or "reject"');
  const comment = typeof d.comment === 'string' ? d.comment.slice(0, 2000) : undefined;
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  const meta = await readMeta(dir, runId);
  if (d.workflowId !== undefined && meta?.workflow?.workflowId !== d.workflowId)
    throw new NotFoundError(`run "${runId}" of workflow "${d.workflowId}"`);
  const runner = await runnerFor(deps, workspace, definition, { reviewer: { id: actor.id } });
  const keys = await approvalKeyring(dataConfig.dataRootDir, deps.env);
  const request = (await runner.listApprovals()).find((a) => a.runId === runId && a.approvalId === approvalId);
  if (request === undefined) throw new NotFoundError(`pending approval "${approvalId}" on run "${runId}"`);
  const signed = signDecision(keys.active.privateKeyPem, {
    v: 1,
    approvalId,
    runId,
    step: request.step,
    action,
    edits: {},
    reviewerId: actor.id,
    at: new Date().toISOString(),
    ...(comment !== undefined ? { comment } : {}),
  });
  // The run may be busy for a moment (a timer firing, another decision): wait for its lease rather than fail.
  let result: RunResult | undefined;
  for (let attempt = 0; result === undefined; attempt++) {
    try {
      result = await runner.decideApproval(runId, signed);
    } catch (e) {
      if (!(e instanceof LeaseError && e.code === 'HELD') || attempt >= 50) throw e;
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  await deps.audit?.tryRecord({
    action: 'generated-workflow.decide',
    actor: actorFromPrincipal(actor),
    correlationId: d.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    type: 'generated-workflow.approval.decided',
    outcome: 'completed',
    metadata: {
      // An item of a batch is named by its batch and index (the audit refuses long opaque values).
      ...(await auditRunRef(new RunStore(dir), runId)),
      step: request.step,
      action,
      state: result.state,
      ...(meta?.workflow !== undefined ? { workflowEntityId: meta.workflow.workflowId } : {}),
    },
  });
  await publishRunChange(dataConfig, workspace.workspaceId, meta, runId, result.state);
  return view(runner, runId, dir, dataConfig.dataRootDir);
}

/** Most entries of each kind the inbox returns; `truncated` says when there were more. */
const INBOX_LIMIT = 200;

/**
 * UW-12b (ADR 0047): everything on the workflow runtime that waits for a person in this workspace, in one read:
 *   - `batches`: batch previews waiting for an approval (unexpired, every item shown exactly, not yet approved) and approved batches
 *     not yet started (unexpired, unused);
 *   - `steps`: approval steps of runs waiting for a reviewer;
 *   - `attention`: external calls whose outcome is unknown, which only a person can reconcile.
 * It decides nothing: each entry names the route that acts on it, and that route checks role, recent sign-in and separation again.
 * `preparedByYou` lets a client say early that someone else must approve; the approve route is what refuses.
 */
export async function controlInbox(deps: RunnerDeps, workspace: WorkspaceRecord, actorId: string): Promise<Record<string, unknown>> {
  const base = join(deps.dataConfig.dataRootDir, workspace.workspaceId, 'generated-runs');
  const { readdir } = await import('node:fs/promises');
  const now = Date.now();
  const batches: Record<string, unknown>[] = [];
  const steps: Record<string, unknown>[] = [];
  const attention: Record<string, unknown>[] = [];
  let truncated = false;
  const push = (list: Record<string, unknown>[], v: Record<string, unknown>): void => {
    if (list.length < INBOX_LIMIT) list.push(v);
    else truncated = true;
  };
  for (const definitionId of (await readdir(base).catch(() => [] as string[])).sort()) {
    let definition: WorkflowDefinitionRecord;
    try {
      definition = await workspaceDefinitionsStore(workspace, deps.dataConfig).get(definitionId);
    } catch {
      continue; // not a definition of this workspace (or unreadable): nothing to act on
    }
    const dir = join(base, definitionId);
    const named = { definitionId, workflowName: definition.workflowName };
    const bs = new BatchStore(batchDir(dir));
    for (const p of await bs.listPreviews()) {
      const approval = await bs.getApprovalOfPreview(p.previewId);
      if (approval !== undefined) {
        if (Date.parse(approval.payload.expiresAt) <= now || (await bs.consumedBy(approval.payload.approvalId)) !== undefined) continue;
      } else if (Date.parse(p.expiresAt) <= now || p.counts.not_exact > 0) continue;
      push(batches, {
        ...named,
        state: approval === undefined ? 'awaiting_approval' : 'ready_to_start',
        previewId: p.previewId,
        certificateId: p.certificateId,
        root: p.root,
        forEach: p.forEach,
        total: p.items.length,
        counts: p.counts,
        senders: p.senders.map((x) => ({
          connector: x.connector,
          ...(x.account !== undefined ? { account: x.account } : {}),
          ...(x.tier !== undefined ? { tier: x.tier } : {}),
        })),
        createdBy: p.createdBy,
        createdAt: p.createdAt,
        expiresAt: approval?.payload.expiresAt ?? p.expiresAt,
        preparedByYou: p.createdBy === actorId,
        ...(approval !== undefined
          ? {
              approval: {
                approvalId: approval.payload.approvalId,
                reviewerId: approval.payload.reviewerId,
                approvedAt: approval.payload.at,
                expiresAt: approval.payload.expiresAt,
              },
            }
          : {}),
      });
    }
    const store = new RunStore(dir);
    const ids = await store.list().catch(() => [] as string[]);
    if (ids.length === 0) continue;
    const itemOf = async (runId: string): Promise<Record<string, unknown>> => {
      if (!runId.startsWith('fe_')) return {};
      const d = ((await store.read(runId).catch(() => []))[0]?.data ?? {}) as { parent?: unknown; index?: unknown };
      return typeof d.parent === 'string' && typeof d.index === 'number' ? { parentRunId: d.parent, item: d.index } : {};
    };
    const runner = await runnerFor(deps, workspace, definition);
    for (const a of await runner.listApprovals().catch(() => []))
      push(steps, {
        ...named,
        runId: a.runId,
        ...(await itemOf(a.runId)),
        approvalId: a.approvalId,
        step: a.step,
        summary: a.summary,
        proposedActions: a.proposedActions,
        requestedAt: a.requestedAt,
        expiresAt: a.expiresAt,
      });
    for (const runId of ids)
      for (const e of effectsOf(await store.read(runId).catch(() => [])))
        if (e.state === 'outcome_unknown' || e.state === 'reconciliation_required')
          push(attention, {
            ...named,
            runId,
            ...(await itemOf(runId)),
            step: e.step,
            connector: e.connector,
            operation: e.operation,
            state: e.state,
            intentAt: e.intentAt,
            detail: e.detail,
          });
  }
  const newest = (k: string) => (a: Record<string, unknown>, b: Record<string, unknown>) => String(b[k]).localeCompare(String(a[k]));
  return {
    batches: batches.sort(newest('createdAt')),
    steps: steps.sort(newest('requestedAt')),
    attention: attention.sort(newest('intentAt')),
    truncated,
  };
}

export function registerGeneratedRunRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  permissionManager: PermissionManager,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const auditCtx = { audit, workspaceStore };
  const deps: RunnerDeps = { workspaceStore, dataConfig, permissionManager, env, audit };

  async function getBindings(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const stored = await readConnectorBindings(workspace, dataConfig);
    const available = installedAdapterIds(dataConfig);
    // UW-10: for an email binding with a connection, the tier it sends in and what that means (shown in Studio's pre-start check).
    const tiers = new Map<string, ReturnType<typeof emailTierOf>>();
    const emailCreds = [
      ...new Set(stored.bindings.flatMap((b) => (b.adapter === 'email' && b.credentialId !== undefined ? [b.credentialId] : []))),
    ];
    if (emailCreds.length > 0) {
      const config = await (dataConfig.credentials ?? (() => loadCredentialsConfig(dataConfig.dataRootDir, env)))().catch(() => undefined);
      if (config !== undefined) {
        const broker = workspaceBroker(workspace, dataConfig.dataRootDir, config);
        for (const id of emailCreds) {
          const c = await broker.describe(id).catch(() => undefined);
          if (c !== undefined) tiers.set(id, emailTierOf(c));
        }
      }
    }
    return json(200, {
      ...stored,
      bindings: stored.bindings.map((b) => {
        const tier = b.credentialId !== undefined ? tiers.get(b.credentialId) : undefined;
        return { ...b, adapterInstalled: available.has(b.adapter), ...(tier !== undefined ? { emailTier: tier } : {}) };
      }),
    });
  }

  /** Replaces the workspace's connector bindings (manage role, recent sign-in, revision-guarded, audited). */
  async function putBindings(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'connector-bindings.update', correlationId });
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'bind connectors' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'bind connectors');
    const body = await req.json<{ bindings?: unknown; expectedRevision?: unknown }>();
    if (!body.ok) throw body.error;
    const bindings = parseConnectorBindings(body.value.bindings);
    // UW-9: a binding may name only an active connection credential of THIS workspace.
    const named = [...new Set(bindings.flatMap((b) => (b.credentialId !== undefined ? [b.credentialId] : [])))];
    if (named.length > 0) {
      const config = await (dataConfig.credentials ?? (() => loadCredentialsConfig(dataConfig.dataRootDir, env)))();
      if (config === undefined)
        throw new XoError(ErrorCode.CREDENTIALS_NOT_CONFIGURED, 'connections are not configured on this instance: set XO_CREDENTIALS_KEY');
      const broker = workspaceBroker(workspace, dataConfig.dataRootDir, config);
      for (const id of named) {
        const c = await broker.describe(id).catch(() => undefined);
        if (c === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, `credential ${id} is not a connection of this workspace`);
        if (c.state !== 'active') throw new XoError(ErrorCode.CREDENTIAL_NOT_ACTIVE, `credential ${id} is ${c.state}; reconnect it first`);
      }
    }
    const current = await readConnectorBindings(workspace, dataConfig);
    if (body.value.expectedRevision !== undefined && body.value.expectedRevision !== current.revision)
      throw new XoError(ErrorCode.PRECONDITION_FAILED, `the bindings changed (revision ${current.revision}); reload and try again`);
    const actor = requirePrincipal(req);
    const next = { revision: current.revision + 1, bindings, updatedAt: new Date().toISOString(), updatedBy: actor.id };
    await writeConnectorBindings(workspace, dataConfig, next);
    await audit.tryRecord({
      action: 'connector-bindings.update',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'workspace', id: workspace.workspaceId },
      type: 'connector-bindings.updated',
      outcome: 'completed',
      metadata: { revision: next.revision, bindings: bindings.length },
    });
    return json(200, next);
  }

  /** Starts a generated workflow as Workflow IR. A current READY (or READY_WITH_CONDITIONS) certificate is always required. */
  async function start(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.run', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'run a generated workflow' });
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const body = await req.json<{ input?: unknown; certificateId?: unknown; batchApprovalId?: unknown }>();
    if (!body.ok) throw body.error;
    const unknown = Object.keys(body.value).filter((k) => k !== 'input' && k !== 'certificateId' && k !== 'batchApprovalId');
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`);
    const input = body.value.input ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be an object');
    if (JSON.stringify(input).length > 1_048_576) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be at most 1 MiB');
    const actor = requirePrincipal(req);
    const started = await startGeneratedRun(deps, {
      workspace,
      actor,
      definition,
      input: input as Record<string, unknown>,
      certificateId: body.value.certificateId,
      idempotencyKey: req.headers['idempotency-key'],
      correlationId,
      ...(body.value.batchApprovalId !== undefined ? { batchApprovalId: body.value.batchApprovalId } : {}),
    });
    return json(started.status, started.body);
  }

  // UW-8 (ADR 0046): batch preview and batch-bound approval.
  async function createPreview(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.batch', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'prepare a batch preview' });
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const body = await req.json<{ input?: unknown; certificateId?: unknown; items?: unknown }>();
    if (!body.ok) throw body.error;
    const unknown = Object.keys(body.value).filter((k) => k !== 'input' && k !== 'certificateId' && k !== 'items');
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`);
    const input = body.value.input ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be an object');
    if (JSON.stringify(input).length > 1_048_576) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be at most 1 MiB');
    return json(
      201,
      await previewGeneratedRun(deps, {
        workspace,
        actor: requirePrincipal(req),
        definition,
        input: input as Record<string, unknown>,
        certificateId: body.value.certificateId,
        correlationId,
        ...(body.value.items !== undefined ? { items: parseItemSourceRef(body.value.items) } : {}),
      }),
    );
  }

  /** V1-1 (ADR 0049): the confirmed lists and pairings this workflow's items can come from, and whether each gives what it reads. */
  async function itemSources(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const component = definition.lowered.component as WorkflowComponent | undefined;
    const over = component?.workflows[0]?.forEach?.over;
    if (component === undefined || over === undefined) return json(200, { forEach: false, sources: [] });
    const needs = itemFieldsUsed(component);
    const sources = (await listItemSources({ workspace, dataConfig })).map((s) => {
      const missing = needs.filter((f) => !s.fields.includes(f));
      return { ...s, missingFields: missing, usable: missing.length === 0 && s.items > 0 };
    });
    return json(200, { forEach: true, over, fieldsUsed: needs, sources });
  }

  async function getPreview(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const bs = new BatchStore(batchDir(runsDir(dataConfig, workspace.workspaceId, definition.definitionId)));
    const preview = await bs.getPreview(req.params['previewId'] ?? '');
    if (preview.definitionId !== definition.definitionId) throw new NotFoundError(`batch preview "${preview.previewId}"`);
    const approval = await bs.getApprovalOfPreview(preview.previewId);
    const used = approval !== undefined ? await bs.consumedBy(approval.payload.approvalId) : undefined;
    const num = (v: string | null): number | undefined => (v !== null && /^[0-9]{1,6}$/.test(v) ? Number(v) : undefined);
    const page = num(req.query.get('page'));
    const size = num(req.query.get('size'));
    const show = req.query.get('show') ?? undefined;
    return json(
      200,
      previewView(preview, approval, used, {
        ...(page !== undefined ? { page } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(show !== undefined ? { show } : {}),
      }),
    );
  }

  async function approvePreview(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.batch', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'approve a batch' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'approve a batch');
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const body = await req.json<{ root?: unknown }>();
    if (!body.ok) throw body.error;
    return json(
      201,
      await approveBatchPreview(deps, {
        workspace,
        actor: requirePrincipal(req),
        definition,
        previewId: req.params['previewId'] ?? '',
        root: body.value.root,
        correlationId,
      }),
    );
  }

  async function status(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const runner = await runnerFor(deps, workspace, definition);
    const runId = req.params['runId'] ?? '';
    try {
      return json(
        200,
        await view(
          runner,
          runId,
          runsDir(dataConfig, workspace.workspaceId, definition.definitionId),
          dataConfig.dataRootDir,
          definition.lowered.component as WorkflowComponent | undefined,
        ),
      );
    } catch {
      throw new NotFoundError(`run "${runId}"`);
    }
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const runner = await runnerFor(deps, workspace, definition);
    const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
    const store = new RunStore(dir);
    const runs = [];
    for (const id of await store.list().catch(() => [] as string[])) {
      const st = await runner.status(id).catch(() => undefined);
      if (st === undefined) continue;
      const meta = await readMeta(dir, id);
      runs.push({
        ...st,
        pendingApprovals: (await runner.listApprovals()).filter((a) => a.runId === id),
        ...(meta !== undefined ? { startedBy: meta.initiator.id } : {}),
      });
    }
    return json(200, { runs: runs.filter((r) => r !== undefined) });
  }

  /** UW-12b: the workspace's runtime inbox (read role). */
  async function inbox(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig, { action: 'read the approval inbox' });
    return json(200, await controlInbox(deps, workspace, requirePrincipal(req).id));
  }

  /** UW-15 (UAC-36): how often this workflow needed a person over the last 30 days, and only the items still waiting for one. */
  async function exceptions(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig, { action: 'read workflow exceptions' });
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const store = new RunStore(runsDir(dataConfig, workspace.workspaceId, definition.definitionId));
    const runs = [];
    for (const id of await store.list().catch(() => [] as string[]))
      runs.push({ runId: id, entries: await store.read(id).catch(() => []) });
    return json(200, exceptionReport(runs, new Date()));
  }

  /** A person decides a human step: review role, recent sign-in; the platform signs the decision as theirs. */
  async function decide(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.decide', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'decide a human step' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'decide a human step');
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const body = await req.json<{ action?: unknown; comment?: unknown }>();
    if (!body.ok) throw body.error;
    return json(
      200,
      await decideGeneratedApproval(deps, {
        workspace,
        actor: requirePrincipal(req),
        definition,
        runId: req.params['runId'] ?? '',
        approvalId: req.params['approvalId'] ?? '',
        action: body.value.action,
        comment: body.value.comment,
        correlationId,
      }),
    );
  }

  async function cancel(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.cancel', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'cancel a workflow run' });
    const body = await req.json<Record<string, unknown>>();
    if (!body.ok) throw body.error;
    const b = body.value ?? {};
    const unknown = Object.keys(b).filter((k) => k !== 'reason');
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    return json(
      200,
      await cancelGeneratedRun(deps, {
        workspace,
        actor: requirePrincipal(req),
        definition,
        runId: req.params['runId'] ?? '',
        reason: b['reason'],
        correlationId,
      }),
    );
  }

  async function reconcileEffect(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.reconcile', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'record the outcome of an external call' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'record the outcome of an external call');
    const body = await req.json<Record<string, unknown>>();
    if (!body.ok) throw body.error;
    const b = body.value ?? {};
    const unknown = Object.keys(b).filter((k) => !['decision', 'reason', 'evidenceExamined'].includes(k));
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    return json(
      200,
      await reconcileGeneratedEffect(deps, {
        workspace,
        actor: requirePrincipal(req),
        definition,
        runId: req.params['runId'] ?? '',
        step: req.params['step'] ?? '',
        decision: b['decision'],
        reason: b['reason'],
        evidenceExamined: b['evidenceExamined'],
        correlationId,
      }),
    );
  }

  // Due timers and approval deadlines advance even when nobody reads the run: every minute, each generated workflow with
  // runs is ticked (the interval never keeps the process alive).
  const tickAll = async (): Promise<void> => {
    const { readdir } = await import('node:fs/promises');
    for (const ws of await readdir(dataConfig.dataRootDir).catch(() => [] as string[])) {
      const runsDir = join(dataConfig.dataRootDir, ws, 'generated-runs');
      for (const definitionId of await readdir(runsDir).catch(() => [] as string[])) {
        try {
          const workspace = await workspaceStore.get(ws);
          if (!workspace.ok) continue;
          const definition = await workspaceDefinitionsStore(workspace.value, dataConfig).get(definitionId);
          const runner = await runnerFor(deps, workspace.value, definition);
          // UW-2: runs that belong to a Workflow entity report a timer- or deadline-driven move to the change feed.
          const dir = join(runsDir, definitionId);
          const linked = new Map<string, RunMeta>();
          for (const f of await readdir(join(dir, 'meta')).catch(() => [] as string[])) {
            const id = f.replace(/\.json$/, '');
            const meta = await readMeta(dir, id);
            if (meta?.workflow !== undefined) linked.set(id, meta);
          }
          const fingerprint = async (id: string): Promise<string> => {
            const st = await runner.status(id).catch(() => undefined);
            const pending = (await runner.listApprovals().catch(() => [])).filter((a) => a.runId === id).map((a) => a.approvalId);
            return `${st?.state ?? '?'}|${pending.sort().join(',')}`;
          };
          const before = new Map<string, string>();
          for (const id of [...linked.keys()]) {
            const f = await fingerprint(id);
            // Only runs still in progress can move on a tick.
            if (/^(created|running|waiting|compensating)\|/.test(f)) before.set(id, f);
            else linked.delete(id);
          }
          await runner.tick();
          for (const [id, meta] of linked) {
            const after = await fingerprint(id);
            if (after !== before.get(id)) await publishRunChange(dataConfig, ws, meta, id, after.split('|')[0] as string);
          }
        } catch {
          // one unreadable workflow never stops the others; its own status read reports the problem
        }
      }
    }
  };
  setInterval(() => void tickAll(), 60_000).unref();

  router.get('/workspaces/:workspaceId/control/inbox', guarded(inbox));
  router.get('/workspaces/:workspaceId/connector-bindings', guarded(getBindings));
  router.put('/workspaces/:workspaceId/connector-bindings', guarded(putBindings));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/runs', guarded(start));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/previews', guarded(createPreview));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/item-sources', guarded(itemSources));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/previews/:previewId', guarded(getPreview));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/previews/:previewId/approve', guarded(approvePreview));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/exceptions', guarded(exceptions));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/runs', guarded(list));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId', guarded(status));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId/approvals/:approvalId', guarded(decide));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId/cancel', guarded(cancel));
  router.post(
    '/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId/effects/:step/reconciliation',
    guarded(reconcileEffect),
  );
}
