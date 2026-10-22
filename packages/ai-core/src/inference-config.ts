import { ConfigError, ErrorCode } from '@xo/errors';
import { loadConfig, type ConfigSchema } from '@xo/config';
import type { Logger } from '@xo/logger';
import type { ModelProvider, ProviderId } from './provider-types.js';
import type { ModelSelectionPolicy } from './model-selection.js';
import { GEMINI_DEFAULT_MODEL, GeminiProvider } from './providers/gemini-provider.js';

/**
 * Inference configuration. Non-secret settings follow `@xo/config`'s
 * convention (`geminiTimeoutMs` -> `XO_GEMINI_TIMEOUT_MS`). The credential
 * keeps the vendor-conventional name `GEMINI_API_KEY` (as the CLI and API
 * factories already do) and is NEVER read through `loadConfig`, so it can't
 * appear in a rendered config.
 *
 * Fail-closed rules: unknown provider => error; `gemini` without a key =>
 * error; no provider selected => inference is explicitly UNCONFIGURED (no
 * silent default, no fallback to another provider or to deterministic
 * execution).
 */
export const INFERENCE_CONFIG_SCHEMA = {
  env: {
    type: 'enum',
    values: ['development', 'test', 'production'],
    default: 'development',
    description: 'Deployment environment (XO_ENV).',
  },
  inferenceProvider: {
    type: 'enum',
    values: ['none', 'gemini'],
    default: 'none',
    description: 'Which inference provider to use. "none" = inference unconfigured.',
  },
  geminiModel: { type: 'string', default: GEMINI_DEFAULT_MODEL, description: 'Gemini model id.' },
  geminiTimeoutMs: { type: 'number', min: 1000, max: 300_000, default: 30_000 },
  geminiMaxOutputTokens: { type: 'number', min: 1, max: 65_536, default: 8192, description: 'Upper bound enforced on any request.' },
  geminiTemperature: { type: 'number', min: 0, max: 2, description: 'Default temperature when a request sets none.' },
  geminiMaxRetries: {
    type: 'number',
    min: 0,
    max: 5,
    description: 'Retries after the first attempt. 0 disables retries. Defaults to 0 when XO_ENV=test, else 2.',
  },
  geminiAckDataUseTerms: {
    type: 'boolean',
    default: false,
    description: 'Required =true when XO_ENV=production: confirms you verified Google data-use terms for your key tier.',
  },
} as const satisfies ConfigSchema;

export type InferenceEnvironment = 'development' | 'test' | 'production';

export interface UnconfiguredInferenceConfig {
  readonly provider: 'none';
  readonly environment: InferenceEnvironment;
}

export interface GeminiInferenceConfig {
  readonly provider: 'gemini';
  readonly environment: InferenceEnvironment;
  readonly model: string;
  /** Secret. Defined non-enumerable so `JSON.stringify` / spread / `console.log` of the config cannot leak it. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly maxRetries: number;
}

export type InferenceConfig = UnconfiguredInferenceConfig | GeminiInferenceConfig;

type Env = Readonly<Record<string, string | undefined>>;

const missing = (message: string): ConfigError => new ConfigError(ErrorCode.CONFIG_MISSING_KEY, message);
const invalid = (message: string): ConfigError => new ConfigError(ErrorCode.CONFIG_INVALID_VALUE, message);

/** Throws `ConfigError` (an unrecoverable boot-time failure, matching `@xo/config`'s own contract) with an actionable message. */
export function resolveInferenceConfig(env: Env = process.env): InferenceConfig {
  const raw = loadConfig(INFERENCE_CONFIG_SCHEMA, { env });
  const environment = raw.env as InferenceEnvironment;
  if (raw.inferenceProvider === 'none') return { provider: 'none', environment };

  const apiKey = env['GEMINI_API_KEY']?.trim();
  if (!apiKey) {
    throw missing(
      'XO_INFERENCE_PROVIDER=gemini but GEMINI_API_KEY is not set. Create a key at https://aistudio.google.com/apikey and export it server-side (never in browser/Studio code).',
    );
  }
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    throw invalid('GEMINI_API_KEY contains whitespace or non-printable characters — check for a stray newline or quote when copying it.');
  }
  const model = raw.geminiModel.trim();
  if (!/^gemini-[a-z0-9][a-z0-9.-]*$/.test(model)) {
    throw invalid(`XO_GEMINI_MODEL must look like "gemini-…", got "${model.slice(0, 60)}".`);
  }
  if (environment === 'production' && !raw.geminiAckDataUseTerms) {
    throw missing(
      "XO_ENV=production with the Gemini provider requires XO_GEMINI_ACK_DATA_USE_TERMS=true. Google's free tier may use submitted content to improve its products; confirm your key's tier and terms (https://ai.google.dev/gemini-api/terms) before setting it.",
    );
  }

  const config: Record<string, unknown> = {
    provider: 'gemini',
    environment,
    model,
    timeoutMs: raw.geminiTimeoutMs,
    maxOutputTokens: raw.geminiMaxOutputTokens,
    maxRetries: raw.geminiMaxRetries !== undefined ? raw.geminiMaxRetries : environment === 'test' ? 0 : 2,
    ...(raw.geminiTemperature !== undefined ? { temperature: raw.geminiTemperature } : {}),
  };
  Object.defineProperty(config, 'apiKey', { value: apiKey, enumerable: false, writable: false });
  return config as unknown as GeminiInferenceConfig;
}

export interface InferenceProviderDeps {
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
}

/** The only place a config becomes a concrete provider. Adding a provider = one new `case` here + one adapter file. */
export function createProviderFromConfig(config: GeminiInferenceConfig, deps: InferenceProviderDeps = {}): ModelProvider {
  switch (config.provider) {
    case 'gemini':
      return new GeminiProvider({
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        maxOutputTokensCap: config.maxOutputTokens,
        retry: { maxRetries: config.maxRetries },
        ...(config.temperature !== undefined ? { defaultTemperature: config.temperature } : {}),
        knownModels: [config.model],
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    default: {
      const unreachable: never = config.provider;
      throw invalid(`Unknown inference provider "${String(unreachable)}"`);
    }
  }
}

export type InferenceResolution =
  | { readonly state: 'unconfigured'; readonly environment: InferenceEnvironment }
  | {
      readonly state: 'configured';
      readonly provider: ModelProvider;
      readonly config: GeminiInferenceConfig;
      readonly policy: ModelSelectionPolicy;
    };

/**
 * Deterministic, explicit provider selection. Returns `unconfigured`
 * (never a fallback provider) when none is selected; throws `ConfigError`
 * for an invalid/incomplete configuration.
 */
export function resolveInference(env: Env = process.env, deps: InferenceProviderDeps = {}): InferenceResolution {
  const config = resolveInferenceConfig(env);
  if (config.provider === 'none') return { state: 'unconfigured', environment: config.environment };
  return {
    state: 'configured',
    provider: createProviderFromConfig(config, deps),
    config,
    policy: singleProviderPolicy(config.provider, config.model),
  };
}

/** A routing policy with exactly one provider and one model: no fallback chain by construction. */
export function singleProviderPolicy(providerId: ProviderId, model: string): ModelSelectionPolicy {
  return { rules: [{ capability: '*', providerOrder: [providerId], modelByProvider: { [providerId]: model } }] };
}

/** Rendering that is safe to log/print: never includes the credential. */
export function describeInferenceConfig(config: InferenceConfig): Readonly<Record<string, unknown>> {
  if (config.provider === 'none') return { provider: 'none', environment: config.environment, state: 'unconfigured' };
  return {
    provider: config.provider,
    environment: config.environment,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    maxRetries: config.maxRetries,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    apiKey: 'set (redacted)',
  };
}

export interface InferenceReadiness {
  /** `configured` means ONLY that settings parsed and a credential is present — not that Google is reachable or the key works. */
  readonly state: 'unconfigured' | 'configured' | 'invalid';
  readonly provider: string;
  readonly model?: string;
  readonly environment?: InferenceEnvironment;
  /** Readiness never calls the vendor (health probes must not trigger billable inference). */
  readonly providerReachable: 'not_checked';
  readonly inferenceVerified: false;
  /** Actionable, credential-free problem descriptions when `state === 'invalid'`. */
  readonly problem?: string;
}

export function describeInferenceReadiness(env: Env = process.env): InferenceReadiness {
  const base = { providerReachable: 'not_checked', inferenceVerified: false } as const;
  try {
    const config = resolveInferenceConfig(env);
    if (config.provider === 'none') return { state: 'unconfigured', provider: 'none', environment: config.environment, ...base };
    return { state: 'configured', provider: config.provider, model: config.model, environment: config.environment, ...base };
  } catch (error) {
    return {
      state: 'invalid',
      provider: env['XO_INFERENCE_PROVIDER'] ?? 'none',
      problem: error instanceof Error ? error.message.slice(0, 300) : 'invalid configuration',
      ...base,
    };
  }
}
