import {
  AnthropicProvider,
  AzureOpenAiProvider,
  GeminiProvider,
  guardProvider,
  OllamaProvider,
  OpenAiProvider,
  resolveResidency,
  type EgressDecision,
  type ModelProvider,
  type ResidencyPolicy,
} from '@xo/ai-core';

/**
 * Builds a model provider from SERVER-SIDE configuration only (environment). Deliberately unlike
 * `routes/runtime/provider-factory.ts`, which reads credentials and base URLs from request headers: chat never
 * accepts a key, endpoint or base URL from the client, so a caller cannot redirect prompts to a server of their
 * choosing or ride on someone else's credential. Returns `undefined` when the provider is not configured.
 */
export type ProviderFactory = (providerId: string) => ModelProvider | undefined;

/**
 * UW-14 — the only place this API builds a model provider, and every provider it builds passes the residency guard
 * (`@xo/ai-core` egress/guarded-provider.ts): in `strict_local` no hosted provider can be reached at all, in `masked_hosted` only a
 * contracted one with typed egress requests. A test fails if a provider class is constructed anywhere else in `apps/api/src`.
 */
export function envProviderFactory(
  env: Readonly<Record<string, string | undefined>> = process.env,
  residency: ResidencyPolicy = resolveResidency(env),
  onDecision?: (decision: EgressDecision) => void,
): ProviderFactory {
  const build = rawProviderFactory(env);
  return (providerId) => {
    const provider = build(providerId);
    if (provider === undefined) return undefined;
    return guardProvider(provider, residency, {
      ...(providerId === 'ollama' ? { endpoint: env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434' } : {}),
      ...(onDecision !== undefined ? { onDecision } : {}),
    });
  };
}

/** Guards providers from any factory (tests and alternative deployments inject their own); guarded providers pass through unchanged. */
export function guardedFactory(factory: ProviderFactory, residency: ResidencyPolicy): ProviderFactory {
  return (providerId) => {
    const provider = factory(providerId);
    return provider === undefined ? undefined : guardProvider(provider, residency);
  };
}

function rawProviderFactory(env: Readonly<Record<string, string | undefined>>): ProviderFactory {
  return (providerId) => {
    switch (providerId) {
      case 'anthropic':
        return env['ANTHROPIC_API_KEY'] ? new AnthropicProvider({ apiKey: env['ANTHROPIC_API_KEY'] }) : undefined;
      case 'openai':
        return env['OPENAI_API_KEY'] ? new OpenAiProvider({ apiKey: env['OPENAI_API_KEY'] }) : undefined;
      case 'azure-openai':
        return env['AZURE_OPENAI_API_KEY'] && env['AZURE_OPENAI_ENDPOINT']
          ? new AzureOpenAiProvider({ apiKey: env['AZURE_OPENAI_API_KEY'], endpoint: env['AZURE_OPENAI_ENDPOINT'] })
          : undefined;
      case 'gemini':
        return env['GEMINI_API_KEY'] ? new GeminiProvider({ apiKey: env['GEMINI_API_KEY'] }) : undefined;
      case 'ollama':
        // UW-17: XO_API_OLLAMA_ENABLED=0 means off (it used to mean on, like any non-empty value).
        return env['OLLAMA_BASE_URL'] || /^(1|true)$/i.test(env['XO_API_OLLAMA_ENABLED'] ?? '')
          ? new OllamaProvider(env['OLLAMA_BASE_URL'] ? { baseUrl: env['OLLAMA_BASE_URL'] } : {})
          : undefined;
      default:
        return undefined;
    }
  };
}
