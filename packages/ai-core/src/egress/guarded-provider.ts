import { inferenceDeniedError } from '../inference-policy.js';
import type { ModelProvider, ProviderRequest, ProviderStreamEvent } from '../provider-types.js';
import { isTypedEgressRequest } from './boundary.js';
import { currentProtection, PATTERN_ONLY_SCANNER } from './protection/context.js';
import { scanRequest } from './protection/scanner.js';
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
  /** UW-14e: what the leak guard found (detector, entity, hash: never a value). */
  readonly hits?: readonly { readonly detector: string; readonly entity: string; readonly hash: string; readonly encoded?: string }[];
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

  const decide = (
    request: ProviderRequest,
    isTyped: boolean,
    denial: { readonly reason: ResidencyDenialReason; readonly message: string } | undefined,
    hits?: EgressDecision['hits'],
  ): void => {
    options.onDecision?.({
      providerId: provider.id,
      locality,
      mode: policy.mode,
      typed: isTyped,
      allowed: denial === undefined,
      ...(denial !== undefined ? { reason: denial.reason } : {}),
      ...(hits !== undefined ? { hits } : {}),
    });
    if (denial !== undefined) {
      throw inferenceDeniedError(
        { reason: denial.reason, message: denial.message, nodeId: 'egress-boundary', providerId: provider.id },
        'runtime',
      );
    }
  };

  /** The residency check: synchronous, so a refused call fails at the call itself (a stream is refused before it exists). */
  const admitResidency = (request: ProviderRequest): void => {
    const isTyped = isTypedEgressRequest(request);
    const denial = checkResidency(policy, { providerId: provider.id, locality, typed: isTyped });
    if (denial !== undefined || locality !== 'hosted') decide(request, isTyped, denial);
  };

  /**
   * UW-14e: the leak guard. A request about to leave for a HOSTED provider is scanned whole, after the residency check and whatever
   * built it, with the workspace's known values and the pattern packs. Any hit blocks it. A local model may see the workspace's own
   * data, so local requests are not scanned.
   */
  const admitLeak = async (request: ProviderRequest): Promise<void> => {
    if (locality !== 'hosted') return;
    const isTyped = isTypedEgressRequest(request);
    const ctx = currentProtection();
    if (ctx === undefined && policy.mode === 'masked_hosted')
      return decide(request, isTyped, {
        reason: 'leak_guard_unavailable',
        message: 'no workspace protection context is set for this request, so it cannot be checked for protected values',
      });
    const verdict = scanRequest(ctx !== undefined ? await ctx.scanner() : PATTERN_ONLY_SCANNER, request);
    if (!verdict.blocked) return decide(request, isTyped, undefined);
    const hits = verdict.hits.map((h) => ({
      detector: h.detector,
      entity: h.entity,
      hash: h.hash,
      ...(h.encoded !== undefined ? { encoded: h.encoded } : {}),
    }));
    await ctx?.onBlocked?.(verdict, { providerId: provider.id });
    const kinds = [...new Set(verdict.hits.map((h) => h.entity))].join(', ');
    decide(
      request,
      isTyped,
      {
        reason: 'leak_guard_blocked',
        message: `the request carries ${verdict.hits.length} protected value(s) (${kinds}); nothing was sent. Hashes: ${[...new Set(hits.map((h) => h.hash))].slice(0, 5).join(', ')}`,
      },
      hits,
    );
  };

  const guarded: ModelProvider = {
    id: provider.id,
    describeCapabilities: () => provider.describeCapabilities(),
    complete: async (request) => {
      admitResidency(request);
      await admitLeak(request);
      return provider.complete(request);
    },
    ...(provider.completeStream !== undefined
      ? {
          completeStream: (request: ProviderRequest): AsyncIterable<ProviderStreamEvent> => {
            admitResidency(request);
            return (async function* () {
              await admitLeak(request);
              yield* provider.completeStream!(request);
            })();
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
