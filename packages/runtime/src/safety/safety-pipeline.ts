import type { RetrievedSlice } from '../retrieval/retrieved-slice.js';

/** Mirrors `@xo/runtime-core`'s `SafetyChecker` verdict vocabulary (`'allow' | 'block' | 'redact'`) — reused directly since it's a plain string union with no packageId-shaped mismatch to work around. */
export type SafetyVerdict = 'allow' | 'block' | 'redact';

export interface SafetyCheckResult {
  readonly verdict: SafetyVerdict;
  readonly reason?: string;
  /** Present only when `verdict === 'redact'`. */
  readonly redactedInput?: string;
}

interface SafetyRule {
  readonly pattern: string;
  readonly action: 'block' | 'redact';
  readonly reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafetyRule(value: unknown): value is SafetyRule {
  return isRecord(value) && typeof value.pattern === 'string' && (value.action === 'block' || value.action === 'redact');
}

/**
 * Parses every `safety_rules` slice's content as `{ "rules":
 * SafetyRule[] }`. Malformed or absent content contributes no rules
 * (never throws) — the pipeline's own default is `'allow'`, so a
 * package that ships unparseable safety rules doesn't block execution
 * outright, but also gains no protection from them; that trade-off is
 * documented, not hidden.
 */
function parseSafetyRules(slices: readonly RetrievedSlice[]): readonly SafetyRule[] {
  const rules: SafetyRule[] = [];
  for (const slice of slices) {
    if (slice.componentKind !== 'safety_rules') continue;
    try {
      const parsed: unknown = JSON.parse(slice.content);
      if (isRecord(parsed) && Array.isArray(parsed.rules)) {
        for (const candidate of parsed.rules) {
          if (isSafetyRule(candidate)) rules.push(candidate);
        }
      }
    } catch {
      // malformed safety_rules content: contributes no rules, doesn't throw
    }
  }
  return rules;
}

function compileRulePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return undefined; // an uncompileable pattern is skipped, not a crash
  }
}

/**
 * Stage 2's deterministic safety gate — pattern matching against a
 * package's own declared `safety_rules` component, evaluated in
 * declaration order with the first matching rule winning. No AI
 * reasoning: this is a hard, auditable check that runs *before* the AI
 * Capability Layer call, not a judgment call delegated to the model
 * being invoked.
 */
export class SafetyPipeline {
  check(input: string, slices: readonly RetrievedSlice[]): SafetyCheckResult {
    const rules = parseSafetyRules(slices);

    for (const rule of rules) {
      const regex = compileRulePattern(rule.pattern);
      if (!regex || !regex.test(input)) continue;

      if (rule.action === 'block') {
        return Object.freeze({ verdict: 'block' as const, ...(rule.reason !== undefined ? { reason: rule.reason } : {}) });
      }
      return Object.freeze({
        verdict: 'redact' as const,
        redactedInput: input.replace(regex, '[REDACTED]'),
        ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
      });
    }

    return Object.freeze({ verdict: 'allow' as const });
  }
}
