import type { CompatibilityResolution } from '@xo/package-sdk';
import type { CapabilityDescriptor } from '../capability/capability-descriptor.js';
import type { PlanId, RequestId } from '../ids.js';

/** One capability considered for a request, paired with how well its package resolves against the request's `HostProfile` and its final rank (`0` = best) among every candidate the negotiator kept. */
export interface RankedCandidate {
  readonly capability: CapabilityDescriptor;
  readonly compatibility: CompatibilityResolution;
  readonly rank: number;
}

export type ExecutionPlanStatus =
  /** At least one compatible candidate was found; `selected` is set. */
  | 'planned'
  /** No mounted package declares the requested capability id, or the search query matched nothing. */
  | 'no_candidates'
  /** Candidates exist, but every one of them was excluded (its package's `fallbackPolicy` is `reject` and it only reached `L0` for this request's host). */
  | 'no_compatible_candidate';

/**
 * The deterministic output of `CapabilityNegotiator.plan` — "discover
 * candidate packages, rank packages, remove incompatible packages,
 * resolve duplicates, prepare an execution plan", with no AI reasoning
 * involved anywhere in producing it. Immutable and, for a given
 * `RuntimeContext` and `ExecutionRequest`, fully reproducible: the same
 * inputs always produce the same `candidates` in the same order.
 */
export interface ExecutionPlan {
  readonly planId: PlanId;
  readonly requestId: RequestId;
  readonly status: ExecutionPlanStatus;
  /** Every candidate that survived incompatibility filtering and duplicate resolution, ranked best-first. */
  readonly candidates: readonly RankedCandidate[];
  /** `candidates[0]`, present iff `status === 'planned'`. */
  readonly selected?: RankedCandidate;
  readonly plannedAt: string;
}
