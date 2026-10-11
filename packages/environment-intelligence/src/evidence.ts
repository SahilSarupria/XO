import type { Principal } from '@xo/permissions';
import type { AuthorityKind } from './authorization.js';
import type { ConnectorOperation } from './connector.js';
import type { ConnectorId, EvidenceId, SourceId } from './ids.js';

/**
 * The kinds of evidence a source can yield. The set is open to growth
 * (connectors for databases, SaaS APIs, audit logs, workflow histories
 * add kinds without touching consumers); the first milestone implements
 * only `resource_inventory` and `document_content`. Nothing about a kind
 * makes it second-class: the environment model consumes `Evidence`
 * uniformly regardless of kind.
 */
export type EvidenceKind =
  | 'resource_inventory'
  | 'metadata'
  | 'schema'
  | 'record'
  | 'event'
  | 'document_content'
  | 'workflow_history'
  | 'integration_metadata'
  | 'admin_inventory';

/** One step of the chain from raw source to this record (principle 2: transformation history). */
export interface TransformationStep {
  readonly step: string;
  readonly version: string;
  readonly at: string;
}

/**
 * Where a piece of evidence came from and under whose authority it was
 * read. Everything here is observable fact about the acquisition, never an
 * assessment of truth. `access.authority` is how a reader can tell
 * platform-authorized evidence from development-only evidence.
 */
export interface ProvenanceRecord {
  readonly sourceId: SourceId;
  readonly connectorId: ConnectorId;
  readonly connectorVersion: string;
  /** Source-relative location (a sanitized relative path, a record id, ...). Never an absolute host path. */
  readonly locator: string;
  /** When the connector observed it (injected clock). */
  readonly observedAt: string;
  readonly access: {
    readonly operation: ConnectorOperation;
    readonly permission: string;
    readonly authority: AuthorityKind;
    readonly decisionReason: string;
    readonly principal?: Principal;
  };
  readonly transformationChain: readonly TransformationStep[];
}

/** JSON-safe payload value. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * An acquired, normalized unit of evidence. It records *what was
 * observed* (a file exists with this size; this content has this digest),
 * not what it means. Raw sensitive content is never stored here: content
 * acquisition yields digests and bounded, validated derived tokens only.
 */
export interface Evidence {
  readonly id: EvidenceId;
  readonly kind: EvidenceKind;
  readonly sourceId: SourceId;
  /** Stable key of the resource within the source (source-relative path). Empty for source-level evidence. */
  readonly resourceKey: string;
  readonly payload: { readonly [key: string]: JsonValue };
  /** `metadata`: describes existence/shape only. `derived_from_content`: computed from file bytes (digest, extracted tokens). */
  readonly sensitivity: 'metadata' | 'derived_from_content';
  readonly provenance: ProvenanceRecord;
}
