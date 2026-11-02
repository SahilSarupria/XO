import type { JsonSchema } from '@xo/ai-core';

const str: JsonSchema = { type: 'string' };
const strs: JsonSchema = { type: 'array', items: str };
const obj = (properties: Record<string, JsonSchema>, required: readonly string[] = Object.keys(properties)): JsonSchema => ({
  type: 'object',
  properties,
  required,
});
const oneOf = (...values: string[]): JsonSchema => ({ type: 'string', enum: values });

export const ROUTE_SCHEMA = obj({
  route: oneOf('ask', 'decide', 'do', 'learn', 'converse'),
  confidence: { type: 'number' },
  reasoning: str,
  standaloneQuery: str,
  needsClarification: { type: 'boolean' },
  clarifyingQuestion: str,
});

const conflict = obj({ summary: str, evidenceIds: strs });

export const ASK_SCHEMA = obj({
  answerable: { type: 'boolean' },
  answer: str,
  confidence: oneOf('high', 'medium', 'low'),
  confidenceReason: str,
  contradictions: { type: 'array', items: conflict },
  gaps: strs,
  followUps: strs,
});

export const DECIDE_SCHEMA = obj({
  summary: str,
  problems: { type: 'array', items: obj({ description: str, evidenceIds: strs }) },
  options: {
    type: 'array',
    items: obj({ title: str, description: str, pros: strs, cons: strs, consequences: strs, dependencies: strs, evidenceIds: strs }),
  },
  recommendedOption: str,
  recommendationRationale: str,
  risks: { type: 'array', items: obj({ description: str, severity: oneOf('low', 'medium', 'high') }) },
  assumptions: strs,
  confidence: oneOf('high', 'medium', 'low'),
  confidenceReason: str,
  contradictions: { type: 'array', items: conflict },
  gaps: strs,
});

export const PROPOSE_SCHEMA = obj({
  capability: str,
  inputs: { type: 'array', items: obj({ name: str, value: str }) },
  rationale: str,
  question: str,
});

export const LEARN_SCHEMA = obj({
  kind: oneOf('correction', 'outcome', 'feedback'),
  statement: str,
});

// Shapes the schemas above guarantee (the ConversationLayer validates before we ever see them).
export interface RouteOutput {
  route: 'ask' | 'decide' | 'do' | 'learn' | 'converse';
  confidence: number;
  reasoning: string;
  standaloneQuery: string;
  needsClarification: boolean;
  clarifyingQuestion: string;
}
export interface RawConflict {
  summary: string;
  evidenceIds: string[];
}
export interface AskOutput {
  answerable: boolean;
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceReason: string;
  contradictions: RawConflict[];
  gaps: string[];
  followUps: string[];
}
export interface DecideOutput {
  summary: string;
  problems: { description: string; evidenceIds: string[] }[];
  options: {
    title: string;
    description: string;
    pros: string[];
    cons: string[];
    consequences: string[];
    dependencies: string[];
    evidenceIds: string[];
  }[];
  recommendedOption: string;
  recommendationRationale: string;
  risks: { description: string; severity: 'low' | 'medium' | 'high' }[];
  assumptions: string[];
  confidence: 'high' | 'medium' | 'low';
  confidenceReason: string;
  contradictions: RawConflict[];
  gaps: string[];
}
export interface ProposeOutput {
  capability: string;
  inputs: { name: string; value: string }[];
  rationale: string;
  question: string;
}
export interface LearnOutput {
  kind: 'correction' | 'outcome' | 'feedback';
  statement: string;
}
