import { err, ok, type Result } from '@xo/types';
import type { ModelProvider } from '@xo/ai-core';
import { AnthropicProvider, AzureOpenAiProvider, GeminiProvider, OllamaProvider, OpenAiProvider } from '@xo/ai-core';
import type { ApiRequest } from '../../http/types.js';

/**
 * Adapted from `apps/cli/src/commands/runtime/provider-factory.ts`'s
 * `resolveProvider` — same provider set, same env-var fallback
 * convention per provider, same "explicit value always wins over env"
 * rule. Not imported directly: `apps/cli` only exposes a `bin` entry in
 * its `package.json` (no `exports`), so it isn't set up to be a
 * dependency of another app — the same reasoning `package-routes.ts`
 * documents for `buildLocalStoreLookup`.
 *
 * The one real adaptation: CLI flags (`--provider`, `--api-key`, ...)
 * become request headers (`x-xo-provider`, `x-xo-api-key`, ...) — the
 * idiomatic place for this kind of per-call configuration in HTTP,
 * mirroring how a CLI flag is the idiomatic place for it on a command
 * line. It deliberately does NOT read these from the JSON body, to keep
 * exactly one channel for provider config rather than two that could
 * disagree.
 */
export const SUPPORTED_PROVIDER_IDS = ['anthropic', 'openai', 'azure-openai', 'gemini', 'ollama'] as const;
export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

function header(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isSupportedProviderId(value: string): value is SupportedProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

export function resolveProvider(req: ApiRequest, env: Readonly<Record<string, string | undefined>> = process.env): Result<ModelProvider, string> {
  const providerId = header(req, 'x-xo-provider') ?? 'anthropic';
  if (!isSupportedProviderId(providerId)) {
    return err(`unknown provider "${providerId}" (x-xo-provider header) — supported: ${SUPPORTED_PROVIDER_IDS.join(', ')}`);
  }

  const apiKeyHeader = header(req, 'x-xo-api-key');
  const baseUrlHeader = header(req, 'x-xo-base-url');
  const endpointHeader = header(req, 'x-xo-endpoint');
  const apiVersionHeader = header(req, 'x-xo-api-version');

  switch (providerId) {
    case 'anthropic': {
      const apiKey = apiKeyHeader ?? env['ANTHROPIC_API_KEY'];
      if (!apiKey) return err('anthropic provider needs an API key — pass the "x-xo-api-key" header or set ANTHROPIC_API_KEY');
      return ok(new AnthropicProvider({ apiKey, ...(baseUrlHeader !== undefined ? { baseUrl: baseUrlHeader } : {}), ...(apiVersionHeader !== undefined ? { apiVersion: apiVersionHeader } : {}) }));
    }
    case 'openai': {
      const apiKey = apiKeyHeader ?? env['OPENAI_API_KEY'];
      if (!apiKey) return err('openai provider needs an API key — pass the "x-xo-api-key" header or set OPENAI_API_KEY');
      return ok(new OpenAiProvider({ apiKey, ...(baseUrlHeader !== undefined ? { baseUrl: baseUrlHeader } : {}) }));
    }
    case 'azure-openai': {
      const apiKey = apiKeyHeader ?? env['AZURE_OPENAI_API_KEY'];
      if (!apiKey) return err('azure-openai provider needs an API key — pass the "x-xo-api-key" header or set AZURE_OPENAI_API_KEY');
      const endpoint = endpointHeader ?? env['AZURE_OPENAI_ENDPOINT'];
      if (!endpoint) return err('azure-openai provider needs an endpoint — pass the "x-xo-endpoint" header or set AZURE_OPENAI_ENDPOINT');
      return ok(new AzureOpenAiProvider({ apiKey, endpoint, ...(apiVersionHeader !== undefined ? { apiVersion: apiVersionHeader } : {}) }));
    }
    case 'gemini': {
      const apiKey = apiKeyHeader ?? env['GEMINI_API_KEY'];
      if (!apiKey) return err('gemini provider needs an API key — pass the "x-xo-api-key" header or set GEMINI_API_KEY');
      return ok(new GeminiProvider({ apiKey, ...(baseUrlHeader !== undefined ? { baseUrl: baseUrlHeader } : {}) }));
    }
    case 'ollama':
      return ok(new OllamaProvider(baseUrlHeader !== undefined ? { baseUrl: baseUrlHeader } : {}));
  }
}
