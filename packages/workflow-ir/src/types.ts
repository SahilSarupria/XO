/**
 * Workflow IR 1.0 — types.
 *
 * A workflow document is DATA. It carries no code, no host paths, no provider
 * or model names and no secrets. Everything a host must supply (filesystem
 * roots, connector endpoints, credentials, models) is referenced by a logical
 * id and bound by the host operator's local policy. That is what lets any
 * conforming runtime execute the same signed document with the same semantics.
 *
 * The published JSON Schema (schema/workflow-1.0.schema.json) is generated from
 * `WORKFLOW_SCHEMA` in schema.ts and is the structural source of truth; these
 * types describe the same shape for TypeScript consumers.
 */

export const WORKFLOW_FORMAT_VERSION = '1.0';
/** Version of the execution semantics (semantics.ts). Independent of the document format so semantics can be negotiated. */
export const WORKFLOW_SEMANTICS_VERSION = '1.0';
export const WORKFLOW_COMPONENT_PATH = 'workflows/workflows.json';

export type Determinism = 'deterministic' | 'model_assisted' | 'human';
export type SideEffect = 'read' | 'write' | 'irreversible';
export type ScalarType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json';
export type Scalar = string | number | boolean | null;

export interface FieldSpec {
  readonly type: ScalarType;
  readonly enum?: readonly string[];
  readonly description?: string;
  /** Upper bound on serialized size in bytes. Required for `json` so a payload can never be unbounded. */
  readonly maxBytes?: number;
  /** The value may be null, meaning "not stated". A `tree` decide step treats null inputs as absent facts. */
  readonly nullable?: boolean;
}

export interface InputSpec extends FieldSpec {
  readonly required?: boolean;
}

/** Where a step input comes from. Closed set: no expressions, no code. */
export type Binding = { readonly from: string; readonly optional?: boolean } | { readonly const: Scalar };

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: {
    readonly kind: 'fixed' | 'exponential';
    readonly baseMs: number;
    readonly maxMs: number;
    readonly jitter: 'none' | 'full';
  };
}

export type OnError = 'fail' | 'escalate' | 'compensate';

export interface StepCommon {
  readonly id: string;
  readonly determinism: Determinism;
  readonly needs?: readonly string[];
  /** Closed expression over this step's own input names. Falsy => the step is `skipped`. */
  readonly runIf?: string;
  readonly inputs?: Readonly<Record<string, Binding>>;
  readonly outputs?: Readonly<Record<string, FieldSpec>>;
  readonly timeoutMs: number;
  readonly retry?: RetryPolicy;
  readonly onError?: OnError;
  /** Required for any step with an external side effect. `{{path}}` placeholders only. */
  readonly idempotencyKey?: string;
  readonly description?: string;
  /** Source sentences / node ids this step was compiled from, when produced by the compiler. */
  readonly provenance?: readonly string[];
}

export interface ExtractStep extends StepCommon {
  readonly type: 'extract';
  readonly instruction: string;
  /** Abstract capability the host must offer; never a provider or model name. */
  readonly requires?: readonly ('structured_output' | 'long_context')[];
  /** If the `structured` input already carries every output field as valid data, the model is not called. */
  readonly structuredFirst?: boolean;
  readonly grounding?: 'none' | 'quote_required';
  readonly maxModelCalls?: number;
}

export interface RuleSpec {
  readonly id: string;
  readonly when: string;
  readonly set: Readonly<Record<string, Scalar>>;
}

export type DecideMethod =
  | { readonly kind: 'tree'; readonly treeId: string }
  | {
      readonly kind: 'rules';
      readonly rules: readonly RuleSpec[];
      readonly onNoMatch: 'escalate' | 'default';
      readonly default?: Readonly<Record<string, Scalar>>;
    }
  | { readonly kind: 'formula'; readonly set: Readonly<Record<string, string>> }
  | {
      readonly kind: 'lookup';
      readonly keys: readonly string[];
      readonly rows: readonly Readonly<Record<string, Scalar>>[];
      readonly onMiss: 'escalate';
    };

export interface DecideStep extends StepCommon {
  readonly type: 'decide';
  readonly method: DecideMethod;
}

export interface ActStep extends StepCommon {
  readonly type: 'act';
  readonly connector: string;
  readonly operation: string;
  readonly sideEffect: SideEffect;
  /** Id of a `compensate` step that undoes this action. */
  readonly compensatedBy?: string;
}

export type ReviewerRole = 'publisher' | 'reviewer' | 'installer' | 'auditor';

export interface ApproveStep extends StepCommon {
  readonly type: 'approve';
  readonly roles: readonly ReviewerRole[];
  /** Summary shown to the reviewer. */
  readonly summary: string;
  /** Names of this step's inputs attached verbatim to the approval request as evidence. */
  readonly evidence?: readonly string[];
  /** Timeouts escalate. There is deliberately no auto-approve value. */
  readonly onTimeout: 'escalate';
  readonly allowEdit?: boolean;
}

export interface BranchStep extends StepCommon {
  readonly type: 'branch';
  readonly cases: readonly { readonly route: string; readonly when: string }[];
  readonly default: string;
}

export type WaitFor =
  | { readonly kind: 'timer'; readonly delayMs: number }
  | { readonly kind: 'event'; readonly name: string; readonly correlationKey: string }
  | { readonly kind: 'approval'; readonly step: string };

export interface WaitStep extends StepCommon {
  readonly type: 'wait';
  readonly for: WaitFor;
  readonly onTimeout: 'escalate' | 'fail';
}

export interface CompensateStep extends StepCommon {
  readonly type: 'compensate';
  readonly compensates: string;
  readonly connector: string;
  readonly operation: string;
  readonly sideEffect: SideEffect;
}

export interface EscalateStep extends StepCommon {
  readonly type: 'escalate';
  /** Who to hand the case to; a `{{ref}}` template so a decision output can name the target. */
  readonly target: string;
  readonly reason: string;
  readonly lane?: string;
}

export type Step = ExtractStep | DecideStep | ActStep | ApproveStep | BranchStep | WaitStep | CompensateStep | EscalateStep;
export type StepType = Step['type'];

/** Bounded fan-out over an array input. The only iteration construct; the step graph itself must be acyclic. */
export interface ForEach {
  readonly over: string;
  readonly maxItems: number;
  readonly concurrency: number;
}

type TriggerMap = { readonly map?: Readonly<Record<string, string>> };
export type Trigger =
  | ({ readonly id: string; readonly kind: 'webhook'; readonly route: string; readonly auth: 'token' | 'hmac' } & TriggerMap)
  | ({ readonly id: string; readonly kind: 'cron'; readonly schedule: string; readonly timezone: string } & TriggerMap)
  | ({ readonly id: string; readonly kind: 'directory'; readonly source: string; readonly pattern: string } & TriggerMap)
  | ({
      readonly id: string;
      readonly kind: 'batch_file';
      readonly source: string;
      readonly format: 'csv' | 'jsonl';
      readonly maxRows: number;
    } & TriggerMap)
  | ({ readonly id: string; readonly kind: 'mcp_event'; readonly server: string; readonly event: string } & TriggerMap)
  | ({ readonly id: string; readonly kind: 'api' } & TriggerMap);

export interface AuthorityCeiling {
  readonly value: Binding;
  readonly max: number;
  /** Over the ceiling the run escalates before any step with side effects. It never proceeds. */
  readonly onExceed: 'escalate';
}

export interface CancellationPolicy {
  readonly onCancel: 'compensate' | 'abandon';
}

export const WORKFLOW_FEATURES = [
  'for_each',
  'approve',
  'wait_event',
  'wait_timer',
  'compensation',
  'model_extract',
  'lookup',
  'rules',
  'authority_ceilings',
] as const;
export type WorkflowFeature = (typeof WORKFLOW_FEATURES)[number];

export interface WorkflowDef {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly triggers: readonly Trigger[];
  readonly inputs: Readonly<Record<string, InputSpec>>;
  readonly steps: readonly Step[];
  readonly forEach?: ForEach;
  /** Names exposed as the run result: `name -> binding`. */
  readonly result?: Readonly<Record<string, Binding>>;
  readonly maxConcurrency: number;
  readonly runTimeoutMs: number;
  readonly cancellation: CancellationPolicy;
  readonly authority?: { readonly ceilings: readonly AuthorityCeiling[] };
  /** Features a host MUST understand to run this workflow. An unknown required feature => the workflow is refused, never degraded. */
  readonly requiresFeatures?: readonly WorkflowFeature[];
}

export interface ConnectorOperationDecl {
  readonly name: string;
  readonly sideEffect: SideEffect;
  /** Secrets this operation needs, by reference name only. Values are never part of a package. */
  readonly secrets?: readonly string[];
}

export const CONNECTOR_KINDS = ['http', 'webhook_out', 'file', 'smtp', 'slack_webhook', 'database', 'mcp'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export interface ConnectorDecl {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly operations: readonly ConnectorOperationDecl[];
}

export interface WorkflowComponent {
  readonly formatVersion: typeof WORKFLOW_FORMAT_VERSION;
  readonly semanticsVersion: string;
  readonly connectors: readonly ConnectorDecl[];
  readonly workflows: readonly WorkflowDef[];
}
