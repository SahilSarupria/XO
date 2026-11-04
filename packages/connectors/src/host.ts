import { canonicalJson, sha256Hex, type ConnectorDecl, type WorkflowComponent } from '@xo/workflow-ir';
import { ConnectorError, type CallRecord, type Connector, type ConnectorPolicy, type ConnectorResult, type Json } from './types.js';
import { Redactor, type SecretVault } from './vault.js';

export interface ConnectorHostOptions {
  readonly component: Pick<WorkflowComponent, 'connectors'>;
  readonly policy: ConnectorPolicy;
  /** Implementations by connector id; kind must match the manifest declaration. */
  readonly implementations: Readonly<Record<string, Connector>>;
  readonly vault: SecretVault;
  readonly record?: (r: CallRecord) => void;
  readonly now?: () => number;
  /** Hard ceiling for any single call regardless of what a step asks for. */
  readonly maxTimeoutMs?: number;
}

export interface CallRequest {
  readonly connector: string;
  readonly operation: string;
  readonly args: Readonly<Record<string, Json>>;
  readonly runId: string;
  readonly stepId: string;
  readonly idempotencyKey?: string;
  readonly timeoutMs: number;
  /** Dry-run: read operations run; anything else is recorded as "would have done" and not executed. */
  readonly dryRun?: boolean;
}

/**
 * The only path from a workflow to the outside world. Order of checks (all fail closed, none degrade):
 * declared in the signed manifest -> granted by the operator's policy -> implementation of the declared kind exists ->
 * secrets resolvable -> idempotency key present for side effects -> dry-run gate -> execute under a timeout.
 */
export class ConnectorHost {
  private readonly declared = new Map<string, ConnectorDecl>();
  readonly redactor = new Redactor();
  constructor(private readonly o: ConnectorHostOptions) {
    for (const c of o.component.connectors) this.declared.set(c.id, c);
  }

  /** Grants actually usable: declared AND granted AND implemented. Useful for `xo` diagnostics and negotiation. */
  effectiveGrants(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [id, decl] of this.declared) {
      const impl = this.o.implementations[id];
      const grant = this.o.policy.connectors[id]?.grant ?? [];
      if (impl === undefined || impl.kind !== decl.kind) continue;
      const ops = decl.operations.filter((op) => grant.includes(op.name) && impl.operations[op.name] !== undefined).map((op) => op.name);
      if (ops.length > 0) out[id] = ops;
    }
    return out;
  }

  async call(req: CallRequest): Promise<ConnectorResult> {
    const now = this.o.now ?? Date.now;
    const started = now();
    const requestHash = sha256Hex(canonicalJson({ c: req.connector, o: req.operation, a: req.args }));
    const finish = (
      rec: Omit<CallRecord, 'connector' | 'operation' | 'runId' | 'stepId' | 'requestHash' | 'durationMs' | 'dryRun'> & {
        sideEffect: CallRecord['sideEffect'];
      },
    ): void =>
      this.o.record?.({
        connector: req.connector,
        operation: req.operation,
        runId: req.runId,
        stepId: req.stepId,
        requestHash,
        durationMs: now() - started,
        dryRun: req.dryRun === true,
        ...rec,
      });
    const refuse = (code: ConnectorError['code'], message: string, sideEffect: CallRecord['sideEffect'] = 'write'): never => {
      finish({ sideEffect, outcome: 'refused', errorCode: code });
      throw new ConnectorError(code, this.redactor.redact(message));
    };

    const decl = this.declared.get(req.connector);
    if (decl === undefined) return refuse('UNDECLARED', `connector "${req.connector}" is not declared by this package`);
    const opDecl = decl.operations.find((o) => o.name === req.operation);
    if (opDecl === undefined) return refuse('UNDECLARED', `operation "${req.operation}" is not declared on connector "${req.connector}"`);
    const se = opDecl.sideEffect;
    const grant = this.o.policy.connectors[req.connector]?.grant;
    if (grant === undefined || !grant.includes(req.operation))
      return refuse('NOT_GRANTED', `operation "${req.connector}.${req.operation}" is not granted by the operator policy`, se);
    const impl = this.o.implementations[req.connector];
    if (impl === undefined) return refuse('NO_IMPLEMENTATION', `no implementation is installed for connector "${req.connector}"`, se);
    if (impl.kind !== decl.kind)
      return refuse(
        'KIND_MISMATCH',
        `connector "${req.connector}" is declared as ${decl.kind} but the installed implementation is ${impl.kind}`,
        se,
      );
    const op = impl.operations[req.operation];
    if (op === undefined)
      return refuse('NO_IMPLEMENTATION', `implementation of "${req.connector}" has no operation "${req.operation}"`, se);
    if (op.sideEffect !== se)
      return refuse(
        'SIDE_EFFECT_MISMATCH',
        `package declares "${req.operation}" as ${se} but the implementation says ${op.sideEffect}`,
        se,
      );
    if (se !== 'read' && req.idempotencyKey === undefined)
      return refuse('MISSING_IDEMPOTENCY_KEY', 'side-effecting calls require an idempotency key', se);

    const secrets = new Map<string, string>();
    for (const name of opDecl.secrets ?? []) {
      const v = this.o.vault.get(name);
      if (v === undefined) return refuse('SECRET_UNAVAILABLE', `secret ${name} is not available in the vault`, se);
      secrets.set(name, v);
      this.redactor.track(name, v);
    }

    if (req.dryRun === true && se !== 'read') {
      finish({ sideEffect: se, outcome: 'dry_run_skipped' });
      return {
        untrusted: true,
        provenance: { connector: req.connector, operation: req.operation },
        dryRun: true,
        data: { would_call: `${req.connector}.${req.operation}`, side_effect: se, request_hash: requestHash },
      };
    }

    const ac = new AbortController();
    const limit = Math.min(req.timeoutMs, this.o.maxTimeoutMs ?? 300_000);
    const timer = setTimeout(() => ac.abort(), limit);
    try {
      const data = await Promise.race([
        op.execute(req.args, {
          ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
          runId: req.runId,
          stepId: req.stepId,
          signal: ac.signal,
          secret: (name) => {
            const v = secrets.get(name);
            if (v === undefined) throw new ConnectorError('DENIED', `secret ${name} was not declared for this operation`);
            return v;
          },
        }),
        new Promise<never>((_, rej) =>
          ac.signal.addEventListener('abort', () => rej(new ConnectorError('TIMEOUT', `call exceeded ${limit}ms`))),
        ),
      ]);
      const safe = this.redactor.redactJson(data);
      finish({ sideEffect: se, outcome: 'ok', responseHash: sha256Hex(canonicalJson(safe)) });
      return { untrusted: true, provenance: { connector: req.connector, operation: req.operation }, dryRun: false, data: safe };
    } catch (e) {
      const ce = e instanceof ConnectorError ? e : new ConnectorError('FAILED', (e as Error).message);
      finish({ sideEffect: se, outcome: 'error', errorCode: ce.code });
      throw new ConnectorError(ce.code, this.redactor.redact(ce.message));
    } finally {
      clearTimeout(timer);
    }
  }
}
