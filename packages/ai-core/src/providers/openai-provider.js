import { AiError, ErrorCode } from '@xo/errors';
/**
 * Real OpenAI Chat Completions integration (`POST /v1/chat/completions`).
 * Uses `response_format: { type: "json_schema", ... }` when the request
 * carries a `responseSchema` — OpenAI's actual structured-output
 * mechanism, unlike Anthropic's (see anthropic-provider.ts), which is why
 * `ProviderCapabilityDescriptor.supportsStructuredOutput` differs
 * meaningfully per provider rather than being a decoration.
 *
 * NOT live-verified in this sandbox (no network/API key) — see this
 * package's README.
 */
export class OpenAiProvider {
    options;
    id = 'openai';
    fetchImpl;
    baseUrl;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.baseUrl = options.baseUrl ?? 'https://api.openai.com';
    }
    describeCapabilities() {
        return {
            providerId: 'openai',
            models: ['gpt-4o', 'gpt-4o-mini'],
            supportsStreaming: true,
            supportsStructuredOutput: true,
            supportsVision: true,
            maxContextTokens: 128_000,
        };
    }
    async complete(request) {
        const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.options.apiKey}`,
            },
            body: JSON.stringify({
                model: request.model,
                max_tokens: request.maxOutputTokens,
                temperature: request.temperature,
                messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
                response_format: request.responseSchema ? { type: 'json_schema', json_schema: { name: 'capability_output', schema: request.responseSchema, strict: true } } : undefined,
            }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `OpenAI API returned ${response.status}: ${body}`);
        }
        const data = (await response.json());
        const choice = data.choices[0];
        if (!choice) {
            throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, 'OpenAI API returned no choices');
        }
        return {
            text: choice.message.content ?? '',
            usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
            modelUsed: data.model,
            finishReason: mapFinishReason(choice.finish_reason),
        };
    }
}
function mapFinishReason(reason) {
    if (reason === 'stop')
        return 'stop';
    if (reason === 'length')
        return 'length';
    if (reason === 'content_filter')
        return 'content_filter';
    return 'error';
}
//# sourceMappingURL=openai-provider.js.map