import type { ProviderId } from '../provider-types.js';

/**
 * UW-14a (ADR 0019, ADR 0020) — where this instance's data may go when a model is asked something.
 *
 * - `strict_local` (default): no hosted model or hosted vision call is possible. Models run on this instance's own server (Ollama on
 *   a loopback or private address) or not at all.
 * - `masked_hosted`: a hosted model may be called only if it is on the operator's list of contracted providers (paid tier, no training
 *   on submitted data) AND the request was built through the typed egress boundary (`boundary.ts`): schema descriptors, synthetic
 *   records, filtered intent text and fixed templates, never a value taken from a document or a cell.
 * - `open`: anything goes. Development only; refused when the instance runs in production.
 *
 * Residency is the fourth inference authority beside node declaration, server policy and run restriction (`inference-policy.ts`),
 * and it is enforced at the provider interface itself (`guarded-provider.ts`), so no caller can forget it.
 */
export type ResidencyMode = 'strict_local' | 'masked_hosted' | 'open';
export const RESIDENCY_MODES: readonly ResidencyMode[] = ['strict_local', 'masked_hosted', 'open'];

export interface ResidencyPolicy {
  readonly mode: ResidencyMode;
  /** `masked_hosted` only: hosted providers whose contract the operator has reviewed (paid, no-training; ADR 0019). */
  readonly contractedProviders: readonly ProviderId[];
}

export const STRICT_LOCAL: ResidencyPolicy = Object.freeze({
  mode: 'strict_local',
  contractedProviders: Object.freeze([]) as readonly ProviderId[],
});

export class ResidencyConfigError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

/** Reads `XO_RESIDENCY` and `XO_HOSTED_MODEL_PROVIDERS`. Unset means `strict_local`. Throws on anything unsafe or unclear. */
export function resolveResidency(env: Env): ResidencyPolicy {
  const raw = (env['XO_RESIDENCY'] ?? '').trim();
  const mode = (raw === '' ? 'strict_local' : raw) as ResidencyMode;
  if (!RESIDENCY_MODES.includes(mode)) throw new ResidencyConfigError(`XO_RESIDENCY must be one of: ${RESIDENCY_MODES.join(', ')}`);
  const production = env['XO_ENV'] === 'production' || env['NODE_ENV'] === 'production';
  if (mode === 'open' && production) {
    throw new ResidencyConfigError(
      'XO_RESIDENCY=open is for development only and is refused in production (use strict_local or masked_hosted)',
    );
  }
  const listed = (env['XO_HOSTED_MODEL_PROVIDERS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (mode === 'masked_hosted' && listed.length === 0) {
    throw new ResidencyConfigError(
      'XO_RESIDENCY=masked_hosted needs XO_HOSTED_MODEL_PROVIDERS: the hosted providers whose paid, no-training contract you have reviewed (for example anthropic)',
    );
  }
  for (const p of listed) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(p))
      throw new ResidencyConfigError(`XO_HOSTED_MODEL_PROVIDERS: "${p.slice(0, 40)}" is not a provider id`);
  }
  return Object.freeze({ mode, contractedProviders: Object.freeze(mode === 'masked_hosted' ? listed : []) });
}

export type ProviderLocality = 'local' | 'hosted';

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^169\.254\./,
];

/**
 * Whether a model endpoint is on this instance's own network. Only Ollama (and test replay) can be local, and only when its address is
 * loopback, a private range, or a name that cannot be a public host (a single label such as a compose service, `.local`, `.internal`,
 * `.svc.cluster.local`, `host.docker.internal`). Everything else, and every unknown provider, is hosted: fail closed.
 */
export function providerLocality(providerId: ProviderId, endpoint?: string): ProviderLocality {
  if (providerId === 'deterministic-replay') return 'local';
  if (providerId !== 'ollama') return 'hosted';
  let host: string;
  try {
    host = new URL(endpoint ?? 'http://localhost:11434').hostname.toLowerCase();
  } catch {
    return 'hosted';
  }
  if (host === 'localhost' || host === '[::1]' || host === '::1' || host === 'host.docker.internal') return 'local';
  if (PRIVATE_V4.some((r) => r.test(host))) return 'local';
  if (/^\[?f[cd][0-9a-f]{2}:/.test(host) || /^\[?fe80:/.test(host)) return 'local';
  if (!host.includes('.')) return 'local';
  if (/\.(local|internal|svc\.cluster\.local|lan|home\.arpa)$/.test(host)) return 'local';
  return 'hosted';
}

export type ResidencyDenialReason = 'residency_hosted_forbidden' | 'residency_provider_not_contracted' | 'residency_untyped_egress';

export interface ResidencyCheckInput {
  readonly providerId: ProviderId;
  readonly locality: ProviderLocality;
  /** The request was built by the typed egress boundary (`buildEgressRequest`). */
  readonly typed: boolean;
}

/** The single rule every path applies. `undefined` = allowed. The message never contains request content. */
export function checkResidency(
  policy: ResidencyPolicy,
  input: ResidencyCheckInput,
): { readonly reason: ResidencyDenialReason; readonly message: string } | undefined {
  if (input.locality === 'local' || policy.mode === 'open') return undefined;
  if (policy.mode === 'strict_local') {
    return {
      reason: 'residency_hosted_forbidden',
      message: `this instance is in strict_local residency: nothing is sent to hosted models ("${input.providerId}"). Use a model on this server (Ollama), or change XO_RESIDENCY.`,
    };
  }
  if (!policy.contractedProviders.includes(input.providerId)) {
    return {
      reason: 'residency_provider_not_contracted',
      message: `"${input.providerId}" is not in XO_HOSTED_MODEL_PROVIDERS (hosted providers with a reviewed paid, no-training contract)`,
    };
  }
  if (!input.typed) {
    return {
      reason: 'residency_untyped_egress',
      message: `masked_hosted residency: "${input.providerId}" may receive only requests built from schema descriptors, synthetic records, filtered intent and fixed templates; this request carried other content and was not sent`,
    };
  }
  return undefined;
}
