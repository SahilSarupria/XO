import { err, ok, type Result } from '@xo/types';
import type { ModelProvider } from '@xo/ai-core';
import { AnthropicProvider, AzureOpenAiProvider, GeminiProvider, OllamaProvider, OpenAiProvider } from '@xo/ai-core';

/**
 * `@xo/ai-core`'s provider classes (`providers/*.ts`) take a plain
 * options object each — `AnthropicProviderOptions`, `OpenAiProviderOptions`,
 * `AzureOpenAiProviderOptions`, `GeminiProviderOptions`,
 * `OllamaProviderOptions` — and none of them reads `process.env` or
 * defines a CLI flag/env-var convention of its own (by design: `@xo/ai-core`
 * stays a pure library, provider *selection* is entirely its caller's
 * concern). `--provider`/`--model`/`--api-key`/`--base-url`/`--endpoint`/
 * `--api-version` here are this CLI's own new convention for supplying
 * those constructor options from the command line or environment — the
 * flag names below map 1:1 onto each provider's own option field names
 * (`apiKey`, `baseUrl`, `endpoint`, `apiVersion`) rather than inventing
 * different ones.
 */
export const SUPPORTED_PROVIDER_IDS = ['anthropic', 'openai', 'azure-openai', 'gemini', 'ollama'] as const;
export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

export interface ProviderFlags {
  readonly provider?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly endpoint?: string;
  readonly apiVersion?: string;
}

function isSupportedProviderId(value: string): value is SupportedProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Resolves one concrete `ModelProvider` from CLI flags plus, per
 * provider, the environment variable most SDKs for that vendor already
 * use by convention (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`, `GEMINI_API_KEY`).
 * `ollama` needs neither — it's a local/self-hosted server, matching
 * `OllamaProviderOptions`' own "no API key by default" doc comment.
 * An explicit `--api-key`/`--endpoint` flag always wins over its
 * environment variable.
 */
export function resolveProvider(flags: ProviderFlags, env: Readonly<Record<string, string | undefined>> = process.env): Result<ModelProvider, string> {
  const providerId = flags.provider ?? 'anthropic';
  if (!isSupportedProviderId(providerId)) {
    return err(`unknown --provider "${providerId}" — supported: ${SUPPORTED_PROVIDER_IDS.join(', ')}`);
  }

  switch (providerId) {
    case 'anthropic': {
      const apiKey = flags.apiKey ?? env['ANTHROPIC_API_KEY'];
      if (!apiKey) return err('anthropic provider needs an API key — pass --api-key or set ANTHROPIC_API_KEY');
      return ok(
        new AnthropicProvider({
          apiKey,
          ...(flags.baseUrl !== undefined ? { baseUrl: flags.baseUrl } : {}),
          ...(flags.apiVersion !== undefined ? { apiVersion: flags.apiVersion } : {}),
        }),
      );
    }
    case 'openai': {
      const apiKey = flags.apiKey ?? env['OPENAI_API_KEY'];
      if (!apiKey) return err('openai provider needs an API key — pass --api-key or set OPENAI_API_KEY');
      return ok(new OpenAiProvider({ apiKey, ...(flags.baseUrl !== undefined ? { baseUrl: flags.baseUrl } : {}) }));
    }
    case 'azure-openai': {
      const apiKey = flags.apiKey ?? env['AZURE_OPENAI_API_KEY'];
      if (!apiKey) return err('azure-openai provider needs an API key — pass --api-key or set AZURE_OPENAI_API_KEY');
      const endpoint = flags.endpoint ?? env['AZURE_OPENAI_ENDPOINT'];
      if (!endpoint) return err('azure-openai provider needs an endpoint — pass --endpoint or set AZURE_OPENAI_ENDPOINT (e.g. https://my-resource.openai.azure.com)');
      return ok(new AzureOpenAiProvider({ apiKey, endpoint, ...(flags.apiVersion !== undefined ? { apiVersion: flags.apiVersion } : {}) }));
    }
    case 'gemini': {
      const apiKey = flags.apiKey ?? env['GEMINI_API_KEY'];
      if (!apiKey) return err('gemini provider needs an API key — pass --api-key or set GEMINI_API_KEY');
      return ok(new GeminiProvider({ apiKey, ...(flags.baseUrl !== undefined ? { baseUrl: flags.baseUrl } : {}) }));
    }
    case 'ollama':
      return ok(new OllamaProvider(flags.baseUrl !== undefined ? { baseUrl: flags.baseUrl } : {}));
  }
}
