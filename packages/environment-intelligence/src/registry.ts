import { parsePermissionId } from '@xo/permissions';
import { SUPPORTED_AUTH_METHODS } from './connector.js';
import type { Connector, ConnectorOperation, DetectedSource, SourceType } from './connector.js';
import type { AuthMethod, ConfigFieldSpec } from './connector.js';
import type { EvidenceKind } from './evidence.js';
import type { ConnectorId } from './ids.js';

/** Every operation a descriptor must state a support level for, and the connector method that implements it. */
const OPERATION_METHODS: Readonly<Record<ConnectorOperation, { readonly method: string; readonly optional: boolean }>> = {
  detect: { method: 'detectSource', optional: false },
  validate_connection: { method: 'validateConnection', optional: false },
  discover: { method: 'discover', optional: false },
  acquire_content: { method: 'acquireContent', optional: false },
  incremental_sync: { method: 'incrementalSync', optional: true },
  health: { method: 'health', optional: true },
};

/** The declared-but-unimplemented labels; only these may be named in a problem code (never connector-supplied text). */
const KNOWN_UNSUPPORTED_AUTH: readonly string[] = ['oauth2', 'api_key', 'service_account', 'database_credentials'];

/** Thrown by `ConnectorRegistry.register` when a connector's self-description is inconsistent. Problem codes are fixed strings, never connector-supplied text. */
export class ConnectorRegistrationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`connector rejected at registration: ${problems.join(', ')}`);
    this.name = 'ConnectorRegistrationError';
  }
}

/**
 * C1: the registration-time consistency rules. Pure; returns fixed problem codes (empty = acceptable). Fails closed:
 *  - every operation states `supported` or `unsupported`; a `supported` one has its method, and an `unsupported` OPTIONAL one has none;
 *  - a `supported` operation declares the permission it will ask for (so the framework can verify it was spent);
 *  - only auth mechanisms that work today (`SUPPORTED_AUTH_METHODS`) may be claimed, and no config field may be a secret.
 */
export function connectorContractProblems(connector: Connector): readonly string[] {
  const problems: string[] = [];
  const d = connector?.descriptor;
  if (d === undefined || d === null || typeof d !== 'object') return ['descriptor_missing'];
  if (typeof d.id !== 'string' || d.id.length === 0) problems.push('descriptor_id');
  if (!Array.isArray(d.sourceTypes) || d.sourceTypes.length === 0) problems.push('source_types_empty');
  if (d.sideEffects !== 'none') problems.push('side_effects_not_none');
  const ops = d.operations as Partial<Record<string, unknown>> | undefined;
  const permissions = (d.requiredPermissions ?? {}) as Partial<Record<string, unknown>>;
  for (const [op, { method, optional }] of Object.entries(OPERATION_METHODS)) {
    const declared = ops?.[op];
    if (declared !== 'supported' && declared !== 'unsupported') {
      problems.push(`operation_undeclared:${op}`);
      continue;
    }
    const present = typeof (connector as unknown as Record<string, unknown>)[method] === 'function';
    if (declared === 'supported') {
      if (!present) problems.push(`method_missing:${op}`);
      const permission = permissions[op];
      if (typeof permission !== 'string' || !parsePermissionId(permission).ok) problems.push(`permission_undeclared:${op}`);
    } else if (optional && present) {
      problems.push(`method_undeclared:${op}`);
    } else if (!optional && !present) {
      problems.push(`method_missing:${op}`);
    }
  }
  if (!Array.isArray(d.authMethods) || d.authMethods.length === 0) problems.push('auth_methods_empty');
  else
    for (const m of d.authMethods)
      if (!(SUPPORTED_AUTH_METHODS as readonly unknown[]).includes(m))
        problems.push(`auth_method_unsupported:${KNOWN_UNSUPPORTED_AUTH.includes(m as string) ? (m as string) : 'unknown'}`);
  if (Array.isArray(d.configFields))
    for (const f of d.configFields) if (f?.secret === true) problems.push('secret_config_field_unsupported');
  return problems;
}

/** Maps source types to connectors. Pure bookkeeping — registering a connector grants it nothing. */
export class ConnectorRegistry {
  private readonly byId = new Map<ConnectorId, Connector>();

  register(connector: Connector): void {
    const problems = connectorContractProblems(connector);
    if (problems.length > 0) throw new ConnectorRegistrationError(problems);
    if (this.byId.has(connector.descriptor.id)) {
      throw new Error(`connector already registered: ${connector.descriptor.id}`);
    }
    this.byId.set(connector.descriptor.id, connector);
  }

  get(id: ConnectorId): Connector | undefined {
    return this.byId.get(id);
  }

  /** Connectors that declare support for `sourceType`, in deterministic id order. */
  findFor(sourceType: SourceType): readonly Connector[] {
    return [...this.byId.values()]
      .filter((c) => c.descriptor.sourceTypes.includes(sourceType))
      .sort((a, b) => (a.descriptor.id < b.descriptor.id ? -1 : 1));
  }
}

export type ConnectionPlan =
  | {
      readonly outcome: 'no_connector';
      readonly sourceType: SourceType;
      readonly reason: string;
    }
  | {
      readonly outcome: 'connector_available';
      readonly connectorId: ConnectorId;
      readonly connectorVersion: string;
      readonly authMethods: readonly AuthMethod[];
      readonly requiredConfig: readonly ConfigFieldSpec[];
      readonly requiredPermissions: Readonly<Partial<Record<ConnectorOperation, string>>>;
      readonly canValidate: boolean;
      readonly canAcquireContent: boolean;
      /** Requested evidence kinds this connector cannot supply (empty = all supported). */
      readonly unsupportedEvidenceKinds: readonly EvidenceKind[];
      /** Things a person/admin must still do before data can be acquired. Never auto-completed. */
      readonly pendingActions: readonly string[];
    };

/**
 * Connection planning: "is there a connector, what does it need, can it
 * give me what I want?" It plans only. It never configures, authorizes,
 * connects, or reads — those are separate, individually-gated states
 * (see source-state.ts). It does not look for, capture, or reuse any
 * credential that happens to be reachable on the machine.
 */
export function planConnection(
  source: DetectedSource,
  registry: ConnectorRegistry,
  wantedEvidence: readonly EvidenceKind[] = [],
): ConnectionPlan {
  const candidates = registry.findFor(source.sourceType);
  const connector = candidates[0];
  if (connector === undefined) {
    return {
      outcome: 'no_connector',
      sourceType: source.sourceType,
      reason: `no registered connector supports source type "${source.sourceType}"`,
    };
  }
  const d = connector.descriptor;
  const unsupportedEvidenceKinds = wantedEvidence.filter((k) => !d.evidenceKinds.includes(k));
  const pendingActions: string[] = [];
  for (const f of d.configFields)
    if (f.required) pendingActions.push(`provide config field "${f.name}"${f.secret ? ' through an approved secret mechanism' : ''}`);
  for (const [op, permission] of Object.entries(d.requiredPermissions))
    pendingActions.push(`authorization for ${permission} (${op}) must be granted by the authorization gate`);
  return {
    outcome: 'connector_available',
    connectorId: d.id,
    connectorVersion: d.version,
    authMethods: d.authMethods,
    requiredConfig: d.configFields,
    requiredPermissions: d.requiredPermissions,
    canValidate: d.operations.validate_connection === 'supported',
    canAcquireContent: d.operations.acquire_content === 'supported',
    unsupportedEvidenceKinds,
    pendingActions,
  };
}
