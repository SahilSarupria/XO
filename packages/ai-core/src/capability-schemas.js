const entityType = {
    type: 'string',
    enum: ['organization', 'person', 'clause', 'law', 'jurisdiction', 'contract_type', 'legal_concept', 'obligation', 'right', 'risk', 'deadline'],
};
const entitiesOutputSchema = {
    type: 'object',
    required: ['entities'],
    properties: {
        entities: {
            type: 'array',
            items: {
                type: 'object',
                required: ['type', 'text', 'startOffset', 'endOffset', 'confidence'],
                properties: {
                    type: entityType,
                    text: { type: 'string' },
                    startOffset: { type: 'number' },
                    endOffset: { type: 'number' },
                    normalizedValue: { type: 'string' },
                    confidence: { type: 'number' },
                },
            },
        },
    },
};
const knowledgeOutputSchema = {
    type: 'object',
    required: ['items', 'relationships'],
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'type', 'statement', 'domain', 'confidence'],
                properties: {
                    id: { type: 'string' },
                    type: { type: 'string', enum: ['fact', 'definition', 'rule', 'concept'] },
                    statement: { type: 'string' },
                    domain: { type: 'string' },
                    confidence: { type: 'number' },
                },
            },
        },
        relationships: {
            type: 'array',
            items: {
                type: 'object',
                required: ['type', 'fromItemId', 'toItemId'],
                properties: {
                    type: { type: 'string', enum: ['depends_on', 'derived_from', 'contradicts', 'references'] },
                    fromItemId: { type: 'string' },
                    toItemId: { type: 'string' },
                },
            },
        },
    },
};
const reasoningOutputSchema = {
    type: 'object',
    required: ['steps', 'tradeoffs', 'exceptions', 'alternativePaths', 'failureModes'],
    properties: {
        steps: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'premise', 'conclusion', 'confidence'],
                properties: { id: { type: 'string' }, premise: { type: 'string' }, conclusion: { type: 'string' }, confidence: { type: 'number' } },
            },
        },
        tradeoffs: {
            type: 'array',
            items: { type: 'object', required: ['description', 'favors', 'against'], properties: { description: { type: 'string' }, favors: { type: 'string' }, against: { type: 'string' } } },
        },
        exceptions: {
            type: 'array',
            items: { type: 'object', required: ['condition', 'deviation'], properties: { condition: { type: 'string' }, deviation: { type: 'string' } } },
        },
        alternativePaths: {
            type: 'array',
            items: {
                type: 'object',
                required: ['description', 'whenApplicable', 'stepIds'],
                properties: { description: { type: 'string' }, whenApplicable: { type: 'string' }, stepIds: { type: 'array', items: { type: 'string' } } },
            },
        },
        failureModes: { type: 'array', items: { type: 'string' } },
    },
};
const capabilitiesOutputSchema = {
    type: 'object',
    required: ['capabilities'],
    properties: {
        capabilities: {
            type: 'array',
            items: {
                type: 'object',
                required: ['name', 'description', 'evidenceExcerptOffsets', 'confidence'],
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    evidenceExcerptOffsets: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                    confidence: { type: 'number' },
                },
            },
        },
    },
};
const decisionGraphOutputSchema = {
    type: 'object',
    required: ['decisions', 'branches', 'escalationPaths', 'riskThresholds', 'fallbacks'],
    properties: {
        decisions: {
            type: 'array',
            items: { type: 'object', required: ['id', 'question', 'dependsOnDecisionIds'], properties: { id: { type: 'string' }, question: { type: 'string' }, dependsOnDecisionIds: { type: 'array', items: { type: 'string' } } } },
        },
        branches: {
            type: 'array',
            items: {
                type: 'object',
                required: ['decisionId', 'condition', 'outcome'],
                properties: { decisionId: { type: 'string' }, condition: { type: 'string' }, outcome: { type: 'string' }, leadsToDecisionId: { type: 'string' } },
            },
        },
        escalationPaths: {
            type: 'array',
            items: { type: 'object', required: ['triggerCondition', 'escalateTo'], properties: { triggerCondition: { type: 'string' }, escalateTo: { type: 'string' } } },
        },
        riskThresholds: {
            type: 'array',
            items: {
                type: 'object',
                required: ['metric', 'thresholdDescription', 'aboveThresholdAction'],
                properties: { metric: { type: 'string' }, thresholdDescription: { type: 'string' }, aboveThresholdAction: { type: 'string' } },
            },
        },
        fallbacks: {
            type: 'array',
            items: { type: 'object', required: ['whenDecisionFails', 'fallbackAction'], properties: { whenDecisionFails: { type: 'string' }, fallbackAction: { type: 'string' } } },
        },
    },
};
const constraintsOutputSchema = {
    type: 'object',
    required: ['constraints', 'confidenceBoundaries'],
    properties: {
        constraints: {
            type: 'array',
            items: {
                type: 'object',
                required: ['kind', 'rule', 'severity', 'applicability'],
                properties: {
                    kind: { type: 'string', enum: ['jurisdiction', 'safety', 'regulatory', 'business'] },
                    rule: { type: 'string' },
                    severity: { type: 'string', enum: ['info', 'warning', 'blocking'] },
                    applicability: { type: 'string' },
                },
            },
        },
        confidenceBoundaries: {
            type: 'array',
            items: { type: 'object', required: ['topic', 'reason'], properties: { topic: { type: 'string' }, reason: { type: 'string' } } },
        },
    },
};
/** Maps each capability to the JSON Schema its output must conform to — the single source of truth `router.ts` validates against and provider adapters request structured output against. */
export const CAPABILITY_OUTPUT_SCHEMAS = {
    extractEntities: entitiesOutputSchema,
    extractKnowledge: knowledgeOutputSchema,
    extractReasoning: reasoningOutputSchema,
    extractCapabilities: capabilitiesOutputSchema,
    extractDecisionGraph: decisionGraphOutputSchema,
    extractConstraints: constraintsOutputSchema,
};
//# sourceMappingURL=capability-schemas.js.map