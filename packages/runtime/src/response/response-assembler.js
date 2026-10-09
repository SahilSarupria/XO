function toStopReason(finishReason) {
    switch (finishReason) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'content_filter':
            return 'content_filtered';
        case 'error':
            return 'error';
    }
}
export class ResponseAssembler {
    assemble(params) {
        return Object.freeze({
            content: params.providerResponse.text,
            stopReason: toStopReason(params.providerResponse.finishReason),
            usage: { promptTokens: params.providerResponse.usage.inputTokens, completionTokens: params.providerResponse.usage.outputTokens },
            capabilityId: params.capability.declaration.id,
            packageName: params.capability.packageName,
            packageVersion: params.capability.packageVersion,
            degraded: params.degraded,
        });
    }
}
//# sourceMappingURL=response-assembler.js.map