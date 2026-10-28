import { ConfigError, ErrorCode } from '@xo/errors';
import { CAPABILITY_OUTPUT_SCHEMAS } from './capability-schemas.js';
import { truncate } from './redaction.js';
import type { ProviderCapabilityDescriptor, ProviderId } from './provider-types.js';
import type { ModelSelectionPolicy } from './model-selection.js';

/**
 * Validation for `ModelSelectionPolicy`, which `selectCandidates` otherwise interprets silently (a typo'd provider id, a missing
 * model entry or a misspelled `allowFallback` just changes behaviour without any signal).
 *
 * Two severities:
 * - `error`: the policy is structurally invalid or ambiguous. `AiCapabilityLayer` refuses to be constructed with one.
 * - `warning`: legal, and sometimes deliberate (e.g. one shared policy listing providers that are only configured in some
 *   environments), but worth seeing. Never thrown; surfaced via `AiCapabilityLayer#policyWarnings` and the logger.
 *
 * The validator accepts `unknown` because policies can come from JSON/config. Messages carry paths and short, truncated
 * excerpts only.
 */

export type PolicyIssueSeverity = 'error' | 'warning';

export type PolicyIssueCode =
  | 'policy_not_object'
  | 'unknown_key'
  | 'rules_not_array'
  | 'rule_not_object'
  | 'capability_invalid'
  | 'capability_duplicate'
  | 'provider_order_invalid'
  | 'provider_order_empty'
  | 'provider_id_invalid'
  | 'provider_duplicate'
  | 'model_map_invalid'
  | 'model_missing'
  | 'model_invalid'
  | 'allow_fallback_invalid'
  | 'rules_empty'
  | 'capability_uncovered'
  | 'model_unreferenced'
  | 'provider_unregistered'
  | 'provider_not_structured_output'
  | 'rule_no_eligible_provider';

export interface PolicyIssue {
  readonly severity: PolicyIssueSeverity;
  readonly code: PolicyIssueCode;
  /** e.g. `rules[1].modelByProvider.openai` */
  readonly path: string;
  readonly message: string;
}

export interface PolicyValidationContext {
  /** Registered providers. When given, registry-dependent warnings are produced (nothing here is ever an error). */
  readonly providers?: ReadonlyMap<ProviderId, ProviderCapabilityDescriptor>;
  /** Mirrors the router (`true`): a provider without structured-output support is skipped at selection time. */
  readonly requireStructuredOutput?: boolean;
}

export interface PolicyValidationResult {
  /** `true` when there are no `error` issues (warnings do not make a policy invalid). */
  readonly ok: boolean;
  readonly issues: readonly PolicyIssue[];
  readonly errors: readonly PolicyIssue[];
  readonly warnings: readonly PolicyIssue[];
}

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(Object.keys(CAPABILITY_OUTPUT_SCHEMAS));
const POLICY_KEYS: ReadonlySet<string> = new Set(['rules', 'allowFallback']);
const RULE_KEYS: ReadonlySet<string> = new Set(['capability', 'providerOrder', 'modelByProvider']);
const MAX_ID_LENGTH = 128;
const MAX_MODEL_LENGTH = 200;
/** Control characters and whitespace anywhere in an id/model would corrupt logs, URLs and cache identities. */
const BAD_TOKEN = /[\u0000- \u007f]/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown): string => truncate(typeof v === 'string' ? JSON.stringify(v) : typeof v, 40);

export function validateModelSelectionPolicy(policy: unknown, context: PolicyValidationContext = {}): PolicyValidationResult {
  const issues: PolicyIssue[] = [];
  const add = (severity: PolicyIssueSeverity, code: PolicyIssueCode, path: string, message: string): void => {
    issues.push({ severity, code, path, message });
  };

  if (!isRecord(policy)) {
    add('error', 'policy_not_object', 'policy', 'policy must be an object with a `rules` array');
    return finish(issues);
  }
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) {
      add(
        'error',
        'unknown_key',
        `policy.${truncate(key, 40)}`,
        `unknown policy key (expected: ${[...POLICY_KEYS].join(', ')}); a misspelling would silently change routing`,
      );
    }
  }
  if (policy['allowFallback'] !== undefined && typeof policy['allowFallback'] !== 'boolean') {
    add('error', 'allow_fallback_invalid', 'policy.allowFallback', '`allowFallback` must be a boolean when present');
  }
  const rules = policy['rules'];
  if (!Array.isArray(rules)) {
    add('error', 'rules_not_array', 'policy.rules', '`rules` must be an array');
    return finish(issues);
  }
  if (rules.length === 0) {
    add('warning', 'rules_empty', 'policy.rules', 'policy has no rules: every capability call fails with AI_NO_ELIGIBLE_PROVIDER');
  }

  const seenCapabilities = new Set<string>();
  const registry = context.providers;

  rules.forEach((rule: unknown, i) => {
    const at = `rules[${i}]`;
    if (!isRecord(rule)) {
      add('error', 'rule_not_object', at, 'rule must be an object');
      return;
    }
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) {
        add('error', 'unknown_key', `${at}.${truncate(key, 40)}`, `unknown rule key (expected: ${[...RULE_KEYS].join(', ')})`);
      }
    }

    const capability = rule['capability'];
    if (typeof capability !== 'string' || (capability !== '*' && !KNOWN_CAPABILITIES.has(capability))) {
      add(
        'error',
        'capability_invalid',
        `${at}.capability`,
        `capability ${show(capability)} must be "*" or one of: ${[...KNOWN_CAPABILITIES].join(', ')}`,
      );
    } else if (seenCapabilities.has(capability)) {
      add(
        'error',
        'capability_duplicate',
        `${at}.capability`,
        `more than one rule for capability "${capability}": only the first would ever apply`,
      );
    } else {
      seenCapabilities.add(capability);
    }

    const order = rule['providerOrder'];
    const orderIds: string[] = [];
    if (!Array.isArray(order)) {
      add('error', 'provider_order_invalid', `${at}.providerOrder`, '`providerOrder` must be an array of provider ids');
    } else {
      if (order.length === 0)
        add('error', 'provider_order_empty', `${at}.providerOrder`, '`providerOrder` is empty: this rule can never select a provider');
      const seen = new Set<string>();
      order.forEach((id: unknown, j) => {
        const p = `${at}.providerOrder[${j}]`;
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH || BAD_TOKEN.test(id)) {
          add(
            'error',
            'provider_id_invalid',
            p,
            `provider id ${show(id)} must be a non-empty string without whitespace or control characters (max ${MAX_ID_LENGTH})`,
          );
          return;
        }
        if (seen.has(id)) {
          add(
            'error',
            'provider_duplicate',
            p,
            `provider "${truncate(id, 60)}" is listed twice: a failing call would be repeated against the same provider and billed again`,
          );
          return;
        }
        seen.add(id);
        orderIds.push(id);
      });
    }

    const models = rule['modelByProvider'];
    if (!isRecord(models)) {
      add('error', 'model_map_invalid', `${at}.modelByProvider`, '`modelByProvider` must be an object mapping provider id to model id');
    } else {
      for (const id of orderIds) {
        const p = `${at}.modelByProvider.${truncate(id, 60)}`;
        if (!Object.hasOwn(models, id)) {
          add(
            'error',
            'model_missing',
            p,
            `provider "${truncate(id, 60)}" is in providerOrder but has no model: it would be skipped silently`,
          );
          continue;
        }
        const model = models[id];
        if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_LENGTH || BAD_TOKEN.test(model)) {
          add(
            'error',
            'model_invalid',
            p,
            `model ${show(model)} must be a non-empty string without whitespace or control characters (max ${MAX_MODEL_LENGTH})`,
          );
        }
      }
      for (const key of Object.keys(models)) {
        if (!orderIds.includes(key) && Array.isArray(order)) {
          add(
            'warning',
            'model_unreferenced',
            `${at}.modelByProvider.${truncate(key, 60)}`,
            `model entry for "${truncate(key, 60)}" is not in providerOrder (typo?): it is never used`,
          );
        }
      }
    }

    if (registry) {
      let eligible = 0;
      for (const id of orderIds) {
        const descriptor = registry.get(id);
        if (!descriptor) {
          add(
            'warning',
            'provider_unregistered',
            `${at}.providerOrder`,
            `provider "${truncate(id, 60)}" is not registered: it will be skipped`,
          );
        } else if (context.requireStructuredOutput === true && !descriptor.supportsStructuredOutput) {
          add(
            'warning',
            'provider_not_structured_output',
            `${at}.providerOrder`,
            `provider "${truncate(id, 60)}" does not support structured output: it will be skipped`,
          );
        } else if (isRecord(models) && Object.hasOwn(models, id)) {
          eligible += 1;
        }
      }
      if (orderIds.length > 0 && eligible === 0) {
        add(
          'warning',
          'rule_no_eligible_provider',
          at,
          'no provider in this rule is registered and eligible: calls it covers fail with AI_NO_ELIGIBLE_PROVIDER',
        );
      }
    }
  });

  if (rules.length > 0 && !seenCapabilities.has('*')) {
    const uncovered = [...KNOWN_CAPABILITIES].filter((c) => !seenCapabilities.has(c));
    if (uncovered.length > 0) {
      add('warning', 'capability_uncovered', 'policy.rules', `no wildcard rule, and no rule for: ${uncovered.join(', ')}`);
    }
  }
  return finish(issues);
}

function finish(issues: PolicyIssue[]): PolicyValidationResult {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { ok: errors.length === 0, issues, errors, warnings };
}

/** Throws `ConfigError` (`CONFIG_INVALID_VALUE`) listing every error; returns the validation result (with any warnings) otherwise. */
export function assertValidModelSelectionPolicy(
  policy: unknown,
  context: PolicyValidationContext = {},
): { readonly policy: ModelSelectionPolicy; readonly result: PolicyValidationResult } {
  const result = validateModelSelectionPolicy(policy, context);
  if (!result.ok) {
    const summary = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new ConfigError(ErrorCode.CONFIG_INVALID_VALUE, `Invalid model selection policy: ${summary}`, {
      context: { issues: result.errors.map((e) => ({ code: e.code, path: e.path })) },
    });
  }
  return { policy: policy as ModelSelectionPolicy, result };
}
