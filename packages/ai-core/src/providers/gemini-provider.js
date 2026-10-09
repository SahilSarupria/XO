import { AiError, ErrorCode } from '@xo/errors';
/**
 * Real Gemini `generateContent` integration. Gemini's API has no
 * `system` role — a system message is folded into `systemInstruction`
 * (its own top-level field), and everything else becomes `contents` with
 * Gemini's `user`/`model` role names (not `user`/`assistant`) — another
 * example of why each vendor gets its own adapter file rather than one
 * "OpenAI-compatible-ish" shim.
 *
 * NOT live-verified in this sandbox (no network/API key) — see this
 * package's README.
 */
export class GeminiProvider {
    options;
    id = 'gemini';
    fetchImpl;
    baseUrl;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com';
    }
    describeCapabilities() {
        return {
            providerId: 'gemini',
            models: ['gemini-1.5-pro', 'gemini-1.5-flash'],
            supportsStreaming: true,
            supportsStructuredOutput: true,
            supportsVision: true,
            maxContextTokens: 1_000_000,
        };
    }
    async complete(request) {
        const systemText = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const contents = request.messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`;
        const response = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                contents,
                systemInstruction: systemText.length > 0 ? { parts: [{ text: systemText }] } : undefined,
                generationConfig: {
                    maxOutputTokens: request.maxOutputTokens,
                    temperature: request.temperature,
                    responseMimeType: request.responseSchema ? 'application/json' : undefined,
                    responseSchema: request.responseSchema,
                },
            }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `Gemini API returned ${response.status}: ${body}`);
        }
        const data = (await response.json());
        const candidate = data.candidates[0];
        if (!candidate) {
            throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, 'Gemini API returned no candidates');
        }
        const text = candidate.content.parts.map((p) => p.text ?? '').join('');
        return {
            text,
            usage: { inputTokens: data.usageMetadata.promptTokenCount, outputTokens: data.usageMetadata.candidatesTokenCount },
            modelUsed: request.model,
            finishReason: mapFinishReason(candidate.finishReason),
        };
    }
}
function mapFinishReason(reason) {
    if (reason === 'STOP')
        return 'stop';
    if (reason === 'MAX_TOKENS')
        return 'length';
    if (reason === 'SAFETY' || reason === 'RECITATION')
        return 'content_filter';
    return 'error';
}
//# sourceMappingURL=gemini-provider.js.map