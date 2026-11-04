import type { ModelProvider } from '@xo/ai-core';
import { RetryingProvider } from '@xo/ab-eval';
import { err, ok, type Result } from '@xo/types';
import { resolveProvider } from '../runtime/provider-factory.js';

export interface OperatorProvider {
  readonly provider: ModelProvider;
  readonly providerId: string;
  readonly model: string;
}

/** Hosts a provider base URL may point at without an explicit operator override. */
const ALLOWED_HOSTS = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'localhost',
  '127.0.0.1',
  '::1',
]);

export function validateEndpoint(raw: string, env: Readonly<Record<string, string | undefined>>): Result<string, string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return err(`XO_PROVIDER_BASE_URL is not a valid URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))
    return err('XO_PROVIDER_BASE_URL must be https (http is only allowed for loopback)');
  if (u.username !== '' || u.password !== '') return err('XO_PROVIDER_BASE_URL must not embed credentials');
  const known = ALLOWED_HOSTS.has(u.hostname) || u.hostname.endsWith('.openai.azure.com');
  if (!known && env['XO_ALLOW_CUSTOM_ENDPOINT'] !== '1') {
    return err(
      `host "${u.hostname}" is not on the provider allowlist; the operator can allow it explicitly by setting XO_ALLOW_CUSTOM_ENDPOINT=1`,
    );
  }
  return ok(raw);
}

/**
 * The only way the CLI's AI-enabled commands obtain a model: **operator
 * configuration from the environment** (`XO_PROVIDER`, `XO_MODEL`, the
 * vendor's usual API-key variable, optionally `XO_PROVIDER_BASE_URL`).
 *
 * There is deliberately no `--api-key`/`--base-url` here: a secret on the
 * command line lands in shell history and process listings, and a caller-chosen
 * base URL is a request-forgery primitive. The person who runs the process is
 * the operator and decides which model and endpoint it may use; nothing a
 * claim, a package or a webhook contains can change either.
 */
export function resolveOperatorProvider(env: Readonly<Record<string, string | undefined>> = process.env): Result<OperatorProvider, string> {
  const model = env['XO_MODEL'];
  if (!model)
    return err(
      'set XO_MODEL to the model id to use (and XO_PROVIDER, default "anthropic", plus the provider API key in its usual variable, e.g. ANTHROPIC_API_KEY or GEMINI_API_KEY)',
    );
  const providerId = env['XO_PROVIDER'] ?? 'anthropic';
  const base = env['XO_PROVIDER_BASE_URL'];
  if (base !== undefined) {
    const v = validateEndpoint(base, env);
    if (!v.ok) return err(v.error);
  }
  const p = resolveProvider({ provider: providerId, ...(base !== undefined ? { baseUrl: base } : {}) }, env);
  if (!p.ok) return err(p.error);
  return ok({ provider: new RetryingProvider(p.value), providerId, model });
}
