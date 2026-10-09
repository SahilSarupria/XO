import { definePromptTemplate } from './prompt-template.js';
const SYSTEM_PREAMBLE = 'You are a precise legal-document analysis engine. You extract structured information exactly as instructed, ' +
    'grounded only in the provided text. You never invent facts not supported by the text. Every offset you report ' +
    'refers to character positions in the exact text provided. Respond with JSON only, matching the required shape exactly.';
export const entitiesPromptV1 = definePromptTemplate('extractEntities', 'v1', (input, excerptText) => [
    { role: 'system', content: SYSTEM_PREAMBLE },
    {
        role: 'user',
        content: `Extract every legal entity from the text below${input.entityTypes ? ` of types: ${input.entityTypes.join(', ')}` : ' (organizations, people, clauses, laws, jurisdictions, contract types, legal concepts, obligations, rights, risks, deadlines)'}. ` +
            `For each, report its type, exact text, character start/end offsets into the text, and your confidence (0-1).\n\nTEXT:\n${excerptText}`,
    },
]);
export const knowledgePromptV1 = definePromptTemplate('extractKnowledge', 'v1', (input, excerptText) => [
    { role: 'system', content: SYSTEM_PREAMBLE },
    {
        role: 'user',
        content: `Extract facts, definitions, rules, and concepts from the text below${input.domainHint ? ` (domain: ${input.domainHint})` : ''}, ` +
            `each with a stable id, plus relationships between them (depends_on, derived_from, contradicts, references) referencing those ids.\n\nTEXT:\n${excerptText}`,
    },
]);
export const reasoningPromptV1 = definePromptTemplate('extractReasoning', 'v1', (input, excerptText) => [
    { role: 'system', content: SYSTEM_PREAMBLE },
    {
        role: 'user',
        content: `Do NOT summarize. Instead, reconstruct the decision logic a domain expert used when writing the text below${input.focusQuestion ? ` — specifically: ${input.focusQuestion}` : ''}. ` +
            'Extract: reasoning steps (premise -> conclusion, with ids), tradeoffs, exception cases, alternative reasoning paths (referencing step ids), and failure modes.\n\n' +
            `TEXT:\n${excerptText}`,
    },
]);
export const capabilitiesPromptV1 = definePromptTemplate('extractCapabilities', 'v1', (input, excerptText) => [
    { role: 'system', content: SYSTEM_PREAMBLE },
    {
        role: 'user',
        content: `Identify professional capabilities demonstrated by the text below${input.domainHint ? ` (domain: ${input.domainHint})` : ''} (e.g. Contract Review, Risk Analysis, Negotiation, Clause Comparison, Compliance Analysis). ` +
            'For each, give a name, description, the character-offset pairs of supporting evidence in the text, and confidence.\n\n' +
            `TEXT:\n${excerptText}`,
    },
]);
export const decisionGraphPromptV1 = definePromptTemplate('extractDecisionGraph', 'v1', (input, excerptText) => [
    { role: 'system', content: SYSTEM_PREAMBLE },
    {
        role: 'user',
        content: `Extract a decision graph from the text below${input.focusQuestion ? ` — specifically: ${input.focusQuestion}` : ''}: decision nodes (with dependencies on other decisions), ` +
            'branch conditions and outcomes, escalation paths, risk thresholds, and fallbacks for when a decision cannot be resolved.\n\n' +
            `TEXT:\n${excerptText}`,
    },
]);
export const constraintsPromptV1 = definePromptTemplate('extractConstraints', 'v1', (input, excerptText) => [
    { role: 'system', content: SYSTEM_PREAMBLE },
    {
        role: 'user',
        content: `Extract constraints from the text below${input.domainHint ? ` (domain: ${input.domainHint})` : ''}: jurisdiction, safety, regulatory, and business constraints, each with a severity, ` +
            'plus any confidence boundaries (topics where the text does not give enough information to be fully confident, and why).\n\n' +
            `TEXT:\n${excerptText}`,
    },
]);
//# sourceMappingURL=default-prompts.js.map