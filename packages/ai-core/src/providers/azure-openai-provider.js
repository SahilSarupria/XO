import { AiError, ErrorCode } from '@xo/errors';
/**
 * Real Azure OpenAI integration. Same request/response *shape* as
 * `openai-provider.ts` (Azure OpenAI mirrors the OpenAI Chat Completions
 * API), but a distinct adapter because the URL structure, auth header,
 * and deployment-vs-model addressing all differ — collapsing the two
 * into one class with a flag would blur exactly the kind of
 * vendor-specific detail this package exists to keep out of everything
 * above `ModelProvider`.
 *
 * NOT live-verified in this sandbox (no network/API key) — see this
 * package's README.
 */
export class AzureOpenAiProvider {
    options;
    id = 'azure-openai';
    fetchImpl;
    apiVersion;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.apiVersion = options.apiVersion ?? '2024-06-01';
    }
    describeCapabilities() {
        return {
            providerId: 'azure-openai',
            models: ['gpt-4o'],
            supportsStreaming: true,
            supportsStructuredOutput: true,
            supportsVision: true,
            maxContextTokens: 128_000,
        };
    }
    async complete(request) {
        const url = `${this.options.endpoint}/openai/deployments/${encodeURIComponent(request.model)}/chat/completions?api-version=${this.apiVersion}`;
        const response = await this.fetchImpl(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'api-key': this.options.apiKey,
            },
            body: JSON.stringify({
                max_tokens: request.maxOutputTokens,
                temperature: request.temperature,
                messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
                response_format: request.responseSchema ? { type: 'json_schema', json_schema: { name: 'capability_output', schema: request.responseSchema, strict: true } } : undefined,
            }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `Azure OpenAI API returned ${response.status}: ${body}`);
        }
        const data = (await response.json());
        const choice = data.choices[0];
        if (!choice) {
            throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, 'Azure OpenAI API returned no choices');
        }
        return {
            text: choice.message.content ?? '',
            usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
            modelUsed: request.model,
            finishReason: choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'content_filter' ? 'content_filter' : 'error',
        };
    }
}
//# sourceMappingURL=azure-openai-provider.js.map