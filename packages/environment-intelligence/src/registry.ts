import type { Connector, ConnectorOperation, DetectedSource, SourceType } from './connector.js';
import type { AuthMethod, ConfigFieldSpec } from './connector.js';
import type { EvidenceKind } from './evidence.js';
import type { ConnectorId } from './ids.js';

/** Maps source types to connectors. Pure bookkeeping — registering a connector grants it nothing. */
export class ConnectorRegistry {
  private readonly byId = new Map<ConnectorId, Connector>();

  register(connector: Connector): void {
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
