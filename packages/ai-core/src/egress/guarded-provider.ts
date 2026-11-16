import { inferenceDeniedError } from '../inference-policy.js';
import type { ModelProvider, ProviderRequest, ProviderStreamEvent } from '../provider-types.js';
import { isTypedEgressRequest } from './boundary.js';
import { checkResidency, providerLocality, type ProviderLocality, type ResidencyDenialReason, type ResidencyPolicy } from './residency.js';

/**
 * UW-14 — the one enforcement point between this instance and any model provider. Every provider the instance builds is wrapped
 * here, and every request is checked against the residency policy before the wrapped provider sees it. A refusal is a structured
 * inference denial (403 XO_AI_INFERENCE_DENIED); the request never reaches the network, and the decision record holds no content.
 */
export interface EgressDecision {
  readonly providerId: string;
  readonly locality: ProviderLocality;
  readonly mode: ResidencyPolicy['mode'];
  readonly typed: boolean;
  readonly allowed: boolean;
  readonly reason?: ResidencyDenialReason;
}

export interface EgressDescriptor {
  readonly providerId: string;
  readonly locality: ProviderLocality;
  readonly policy: ResidencyPolicy;
  /** Whether an ordinary (untyped) request, such as a chat turn with document text, may go to this provider. */
  readonly rawAllowed: boolean;
  /** Whether a typed egress request may. */
  readonly typedAllowed: boolean;
  /** Why raw requests are refused, when they are. */
  readonly rawRefusal?: string;
}

export interface GuardOptions {
  /** The provider's endpoint (Ollama's base URL), which decides whether it runs on this instance's own network. */
  readonly endpoint?: string;
  readonly onDecision?: (decision: EgressDecision) => void;
}

const DESCRIPTORS = new WeakMap<object, EgressDescriptor>();

export function egressOf(provider: ModelProvider): EgressDescriptor | undefined {
  return DESCRIPTORS.get(provider);
}

export function guardProvider(provider: ModelProvider, policy: ResidencyPolicy, options: GuardOptions = {}): ModelProvider {
  const existing = DESCRIPTORS.get(provider);
  if (existing !== undefined && existing.policy === policy) return provider;
  const locality = providerLocality(provider.id, options.endpoint);
  const raw = checkResidency(policy, { providerId: provider.id, locality, typed: false });
  const typed = checkResidency(policy, { providerId: provider.id, locality, typed: true });

  const admit = (request: ProviderRequest): void => {
    const isTyped = isTypedEgressRequest(request);
    const denial = checkResidency(policy, { providerId: provider.id, locality, typed: isTyped });
    options.onDecision?.({
      providerId: provider.id,
      locality,
      mode: policy.mode,
      typed: isTyped,
      allowed: denial === undefined,
      ...(denial !== undefined ? { reason: denial.reason } : {}),
    });
    if (denial !== undefined) {
      throw inferenceDeniedError(
        { reason: denial.reason, message: denial.message, nodeId: 'egress-boundary', providerId: provider.id },
        'runtime',
      );
    }
  };

  const guarded: ModelProvider = {
    id: provider.id,
    describeCapabilities: () => provider.describeCapabilities(),
    complete: async (request) => {
      admit(request);
      return provider.complete(request);
    },
    ...(provider.completeStream !== undefined
      ? {
          completeStream: (request: ProviderRequest): AsyncIterable<ProviderStreamEvent> => {
            admit(request);
            return provider.completeStream!(request);
          },
        }
      : {}),
  };
  DESCRIPTORS.set(guarded, {
    providerId: provider.id,
    locality,
    policy,
    rawAllowed: raw === undefined,
    typedAllowed: typed === undefined,
    ...(raw !== undefined ? { rawRefusal: raw.message } : {}),
  });
  return guarded;
}
