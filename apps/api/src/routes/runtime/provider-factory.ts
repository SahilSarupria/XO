import { err, ok, type Result } from '@xo/types';
import { ConfigError } from '@xo/errors';
import { resolveInference, type ModelProvider } from '@xo/ai-core';
import type { ApiRequest } from '../../http/types.js';

/**
 * TRUST BOUNDARY — the provider is SERVER policy, never caller input.
 *
 * Callers of this API are arbitrary API-key holders (keys are issued to
 * identities, including `service` principals), not trusted operators. If a
 * caller could choose the provider or supply its own credential/endpoint:
 *
 *   - a caller-chosen `base-url`/`endpoint` forwards a credential (or the
 *     server's env credential) to an arbitrary host (SSRF + key exfiltration);
 *   - a caller-supplied provider key bypasses the operator's provider choice,
 *     spend controls and data-governance posture (e.g. the Gemini free-tier
 *     data-use acknowledgement);
 *   - caller keys would transit proxies/APM/access logs in a header, and
 *     this API has no rate limiting, key validation or per-caller quota to
 *     contain that.
 *
 * So the provider comes ONLY from server configuration (`XO_INFERENCE_PROVIDER`
 * + server-held credentials via `@xo/ai-core`'s `resolveInference`). There is
 * deliberately NO implicit default provider. Any `x-xo-*` provider header is
 * REJECTED (not silently ignored), so a client that believes it is steering
 * the model learns that it is not.
 *
 * The CLI keeps `--provider/--api-key/...`: there the caller IS the operator
 * on their own machine. See `apps/cli/.../provider-factory.ts`.
 *
 * NOTE: the only caller (`POST /workspaces/:id/runtime/execute`) is currently
 * disabled (501 before this runs). This function is the safe shape for when
 * it is re-enabled; re-enabling still requires the P1.0 M2 authorization gate.
 */
export const CLIENT_PROVIDER_HEADERS = ['x-xo-provider', 'x-xo-api-key', 'x-xo-base-url', 'x-xo-endpoint', 'x-xo-api-version'] as const;

export function resolveProvider(
  req: ApiRequest,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<ModelProvider, string> {
  const supplied = CLIENT_PROVIDER_HEADERS.filter((name) => req.headers[name] !== undefined);
  if (supplied.length > 0) {
    return err(
      `provider configuration is controlled by the server and cannot be set per request — remove header(s): ${supplied.join(', ')}`,
    );
  }
  try {
    const resolution = resolveInference(env);
    if (resolution.state === 'unconfigured') {
      return err('inference is not configured on this server (set XO_INFERENCE_PROVIDER; see docs/inference-gemini.md)');
    }
    return ok(resolution.provider);
  } catch (cause) {
    if (cause instanceof ConfigError) return err(`inference configuration is invalid: ${cause.message}`);
    throw cause;
  }
}
