import { AnthropicProvider, AzureOpenAiProvider, GeminiProvider, OllamaProvider, OpenAiProvider, type ModelProvider } from '@xo/ai-core';

/**
 * Builds a model provider from SERVER-SIDE configuration only (environment). Deliberately unlike
 * `routes/runtime/provider-factory.ts`, which reads credentials and base URLs from request headers: chat never
 * accepts a key, endpoint or base URL from the client, so a caller cannot redirect prompts to a server of their
 * choosing or ride on someone else's credential. Returns `undefined` when the provider is not configured.
 */
export type ProviderFactory = (providerId: string) => ModelProvider | undefined;

export function envProviderFactory(env: Readonly<Record<string, string | undefined>> = process.env): ProviderFactory {
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
        return env['OLLAMA_BASE_URL'] || env['XO_API_OLLAMA_ENABLED']
          ? new OllamaProvider(env['OLLAMA_BASE_URL'] ? { baseUrl: env['OLLAMA_BASE_URL'] } : {})
          : undefined;
      default:
        return undefined;
    }
  };
}
