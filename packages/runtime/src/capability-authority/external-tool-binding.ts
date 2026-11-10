import { err, ok } from '@xo/types';
import type { CapabilityInputSchema } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { validateCapabilityInput } from '@xo/capability-contract';
import type { BindingOutcome, BindingResolver, CapabilityBinding, SemanticCapabilityContract } from '@xo/capability-contract';
import { BlobDispatchLedger, BlobPayloadApprovalStore, ExternalToolDispatcher } from '@xo/adapters';
import type {
  ApprovalMode,
  DispatchContext,
  DispatchEvidence,
  ExternalToolAdapter,
  ReconcileOutcome,
  ReconcileRequest,
} from '@xo/adapters';
import type { AtomicBlobStore } from '@xo/storage';
import type { RuntimeCapabilityHandler } from './runtime-capability-declaration.js';

/**
 * M4 — the external_tool binding path of the capability-authority layer.
 *
 * AUTHORITY. A contract (or a `.xo` declaration) that merely says
 * `external_tool` grants NOTHING. A contract resolves to an `external_tool`
 * binding only when the host explicitly configured an adapter for that
 * contract id on an `ExternalToolDispatcher` and passed the wiring below to the
 * execution call. No standard resolver ever produces such a binding, and
 * `registerResolvedCapabilityBinding` refuses an `external_tool` binding
 * unless the caller supplies the handler built here. Dispatch itself happens
 * inside `RuntimeCapabilityExecutor` — i.e. only after authorization and the
 * confidence gate — and the wiring never retries.
 */

/** What a failed external call says about the external system. `not_dispatched` means the adapter was never called. */
export type ExternalEffectFailureState = 'not_dispatched' | 'confirmed_failure_no_effect' | 'outcome_unknown';

/** A RuntimeError that carries the effect state. Never produced on success. */
export class ExternalEffectError extends RuntimeError {
  constructor(
    code: ConstructorParameters<typeof RuntimeError>[0],
    message: string,
    readonly effectState: ExternalEffectFailureState,
    /** True when a prior or current ambiguous attempt must be reconciled before another dispatch. */
    readonly reconciliationRequired: boolean,
    /** True when nothing was dispatched because a new attempt after a confirmed no-effect failure needs a fresh human approval. */
    readonly freshApprovalRequired: boolean = false,
    /** True when nothing was dispatched because payload-level approval (a human's approval of this exact input) is missing, mismatched or spent. */
    readonly payloadApprovalRequired: boolean = false,
  ) {
    super(code, message);
  }
}

export interface ExternalToolWiring {
  /** Whether the dispatch evidence behind this wiring survives a restart. A host serving production traffic must refuse anything but `'durable'`. */
  readonly ledgerDurability: 'durable' | 'volatile';
  /** Resolves ONLY contracts the host explicitly configured; `undefined` for every other contract. */
  readonly resolver: BindingResolver;
  /** What the host configured for a contract (adapter id + input schema), or `undefined` when not configured. Used to bind that configuration into approval state. */
  describe(contractId: string):
    | {
        readonly adapterId: string;
        readonly inputSchema: CapabilityInputSchema;
        readonly configDigest: string;
        readonly approvalMode: ApprovalMode;
      }
    | undefined;
  /** Builds the handler for one dispatch. `dispatchKey` is server-derived by the caller. */
  handlerFor(contract: SemanticCapabilityContract, dispatchKey: string, context?: DispatchContext): RuntimeCapabilityHandler;
  /** The ordered, durable evidence of one dispatch (empty if none). Rejects if the ledger is unreadable or corrupt. */
  evidenceFor(dispatchKey: string): Promise<readonly DispatchEvidence[]>;
  /**
   * Records an AUTHORIZED reconciliation decision for an unsettled dispatch. The caller (the API route) must already have authenticated
   * the actor and checked authority; this never invokes an adapter and never redispatches.
   */
  reconcile(request: ReconcileRequest): Promise<ReconcileOutcome>;
  /** The exact action `input` would dispatch (digest + summary), for a payload approver. Throws `CanonicalizationError` on an unsupported input. */
  previewAction: ExternalToolDispatcher['previewAction'];
  /** Records a human's payload approval for one dispatch key (see `ExternalToolDispatcher.grantPayloadApproval`). Never dispatches. */
  grantPayloadApproval: ExternalToolDispatcher['grantPayloadApproval'];
  /** Payload approvals recorded for one dispatch key, with their use. */
  payloadApprovalsFor: ExternalToolDispatcher['payloadApprovalsFor'];
}

export const EXTERNAL_TOOL_RESOLVER_NAME = 'ConfiguredExternalToolBindingResolver';

export function createExternalToolWiring(
  dispatcher: ExternalToolDispatcher,
  /** REQUIRED per configured capability: input is validated against it, after authorization and before any dispatch. A configured capability without a schema never resolves (fail closed). */
  inputSchemas: ReadonlyMap<string, CapabilityInputSchema>,
): ExternalToolWiring {
  const resolver: BindingResolver = {
    name: EXTERNAL_TOOL_RESOLVER_NAME,
    resolve(contract: SemanticCapabilityContract): BindingOutcome | undefined {
      if (!dispatcher.isConfigured(contract.id)) return undefined;
      if (!inputSchemas.has(contract.id)) {
        return {
          status: 'unresolved',
          reason: `external_tool capability "${contract.id}" is configured without an input schema; refusing to bind`,
        };
      }
      const adapterId = dispatcher.adapterIdFor(contract.id) ?? 'unknown';
      const binding: CapabilityBinding = {
        id: `external_tool:${adapterId}:${contract.id}`,
        contractId: contract.id,
        implementationClass: 'external_tool',
        resolverName: EXTERNAL_TOOL_RESOLVER_NAME,
        description: `Explicitly configured external_tool adapter "${adapterId}" for contract "${contract.id}"`,
        derivation: { adapterId, configured: true },
      };
      return { status: 'resolved', binding };
    },
  };

  return {
    resolver,
    ledgerDurability: dispatcher.ledgerDurability,
    describe(contractId) {
      const schema = inputSchemas.get(contractId);
      const adapterId = dispatcher.adapterIdFor(contractId);
      const configDigest = dispatcher.configDigestFor(contractId);
      return schema === undefined || adapterId === undefined || configDigest === undefined
        ? undefined
        : { adapterId, inputSchema: schema, configDigest, approvalMode: dispatcher.approvalModeFor(contractId) as ApprovalMode };
    },
    evidenceFor: (dispatchKey) => dispatcher.evidenceFor(dispatchKey),
    reconcile: (request) => dispatcher.reconcile(request),
    previewAction: (capabilityId, input) => dispatcher.previewAction(capabilityId, input),
    grantPayloadApproval: (request) => dispatcher.grantPayloadApproval(request),
    payloadApprovalsFor: (dispatchKey) => dispatcher.payloadApprovalsFor(dispatchKey),
    handlerFor(contract, dispatchKey, context) {
      const handler: RuntimeCapabilityHandler = async (input) => {
        // Contract/input validation precedes dispatch (the handler itself only runs after authorization).
        const schema = inputSchemas.get(contract.id);
        const validation = schema === undefined ? undefined : validateCapabilityInput(schema, input);
        if (schema === undefined || validation === undefined || !validation.valid) {
          const issues =
            validation !== undefined && !validation.valid
              ? validation.issues.map((i) => `${i.property}: ${i.message}`).join('; ')
              : 'no input schema';
          return err(
            new ExternalEffectError(
              ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID,
              `external_tool "${contract.id}" input rejected before dispatch (${issues})`,
              'not_dispatched',
              false,
            ),
          );
        }
        const outcome = await dispatcher.dispatch(contract.id, dispatchKey, input, context);
        switch (outcome.kind) {
          case 'confirmed_success':
            return ok(outcome.output);
          case 'confirmed_failure_no_effect':
            return err(
              new ExternalEffectError(
                ErrorCode.RUNTIME_EXECUTION_FAILED,
                `external_tool "${contract.id}": confirmed failure, no effect (${outcome.code}): ${outcome.message}`,
                'confirmed_failure_no_effect',
                false,
              ),
            );
          case 'outcome_unknown':
            return err(
              new ExternalEffectError(
                ErrorCode.RUNTIME_EXECUTION_FAILED,
                `external_tool "${contract.id}": outcome unknown (${outcome.reason}); reconciliation is required before any further dispatch`,
                'outcome_unknown',
                true,
              ),
            );
          case 'blocked_prior_dispatch':
            return err(
              new ExternalEffectError(
                ErrorCode.RUNTIME_EXECUTION_FAILED,
                `external_tool "${contract.id}": not dispatched — ${outcome.reason}`,
                'not_dispatched',
                outcome.requiresReconciliation,
              ),
            );
          case 'fresh_approval_required':
            return err(
              new ExternalEffectError(
                ErrorCode.RUNTIME_EXECUTION_FAILED,
                `external_tool "${contract.id}": not dispatched — ${outcome.reason}`,
                'not_dispatched',
                false,
                true,
              ),
            );
          case 'payload_approval_required':
            return err(
              new ExternalEffectError(
                ErrorCode.RUNTIME_EXECUTION_FAILED,
                `external_tool "${contract.id}": not dispatched — ${outcome.reason}`,
                'not_dispatched',
                false,
                false,
                true,
              ),
            );
          case 'not_configured':
            return err(
              new ExternalEffectError(ErrorCode.RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED, outcome.reason, 'not_dispatched', false),
            );
          case 'invalid_request':
            return err(new ExternalEffectError(ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID, outcome.reason, 'not_dispatched', false));
          case 'ledger_unavailable':
            return err(new ExternalEffectError(ErrorCode.RUNTIME_EXECUTION_FAILED, outcome.reason, 'not_dispatched', false));
        }
      };
      return handler;
    },
  };
}

export interface DurableExternalToolWiringOptions {
  /** Explicit host configuration: capability (contract) id -> adapter. Nothing else can ever be dispatched. */
  readonly adapters: ReadonlyMap<string, ExternalToolAdapter>;
  /** REQUIRED per configured capability (see {@link createExternalToolWiring}). */
  readonly inputSchemas: ReadonlyMap<string, CapabilityInputSchema>;
  /**
   * Where dispatch evidence lives. REQUIRED, with no default: the host must name a persistent store (e.g. a `LocalFsBlobStore` on a real,
   * backed-up directory). Atomicity is only as strong as this store's `putIfAbsent` (a single filesystem for `LocalFsBlobStore`).
   */
  readonly evidenceStore: AtomicBlobStore;
}

/**
 * The supported way for a host to enable external tools: the evidence ledger is a `BlobDispatchLedger` over the store the host supplies,
 * so the resulting wiring is durable by construction. There is no overload that accepts an in-memory ledger; tests that need one build
 * `new ExternalToolDispatcher({ ..., unsafeAllowVolatileLedger: true })` and `createExternalToolWiring` themselves.
 */
export function createDurableExternalToolWiring(options: DurableExternalToolWiringOptions): ExternalToolWiring {
  if (options.evidenceStore === undefined || options.evidenceStore === null) {
    throw new Error('external tools require an explicit durable evidence store; none was configured');
  }
  const dispatcher = new ExternalToolDispatcher({
    adapters: options.adapters,
    ledger: new BlobDispatchLedger(options.evidenceStore),
    // Payload approvals live in the same durable store as the dispatch evidence (separate prefix); atomic consumption uses its `putIfAbsent`.
    payloadApprovals: new BlobPayloadApprovalStore(options.evidenceStore),
  });
  return createExternalToolWiring(dispatcher, options.inputSchemas);
}
