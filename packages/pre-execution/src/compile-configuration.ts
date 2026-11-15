/**
 * PX-1 (gap PX-G07): one compile configuration for every surface.
 *
 * The API, the CLI and Studio used to pass different options to `compileSources` (only the API configured OCR, only
 * `xo create` passed a review ledger, no surface passed precedence or connectors), so the same sources compiled differently
 * by surface. A `CompileConfiguration` is the serializable statement of everything that changes the result; its digest is
 * recorded in the compilation artifact, so two artifacts are comparable only when their configuration digests agree.
 *
 * Things that are not data — OCR engines, recovery caches, model providers — are supplied separately as a `CompileRuntime`.
 * The configuration states which of them were meant to be present (`ocr.mode`), so a run without the declared OCR engine is
 * visible rather than silently different.
 */
import {
  resolveDomainProfile,
  type CompileSourcesOptions,
  type ConfirmedRule,
  type ConnectorDeclaration,
  type PageTier,
  type ExtractionBudget,
  type RecoveryCache,
} from '@xo/compiler';
import { digestOf, type Digest } from './canonical.js';

export const COMPILE_CONFIGURATION_SCHEMA = 'xo.compile-configuration.v1';

export interface CompileConfiguration {
  readonly schema: typeof COMPILE_CONFIGURATION_SCHEMA;
  /** Page recovery: `off` (unread pages stay unaccounted), `local` (local OCR), `local+vision` (adds a budgeted vision model). */
  readonly ocr: { readonly mode: 'off' | 'local' | 'local+vision'; readonly visionModel?: string; readonly maxCostUsd?: number };
  readonly domainHint?: string;
  /** Domain profile id whose vocabulary extends the neutral grammar, or `auto` to apply the profile identified from the text. */
  readonly profile?: string;
  /** A question the compilation should focus on (prompt-driven scope). */
  readonly focusQuestion?: string;
  /** Authority ranking by source path, highest first. Without it rule conflicts are reported unresolved. */
  readonly precedence?: readonly string[];
  /** Connectors the operator declares; a declared operation binds only to a connector that lists it. */
  readonly connectors?: readonly ConnectorDeclaration[];
  /** Human-confirmed rules for review-list sentences. */
  readonly confirmedRules?: readonly ConfirmedRule[];
  /** Whether policy synthesis (decision trees, workflow emission) runs. */
  readonly policy: 'default' | 'off';
}

/** Not data: engines and caches a run uses. Kept out of the digest; `ocr.mode` states what was intended. */
export interface CompileRuntime {
  readonly pageTiers?: readonly PageTier[];
  readonly extractionBudget?: ExtractionBudget;
  readonly recoveryCache?: RecoveryCache;
  /** Fixed clock for reproducible node timestamps (they are not part of any content hash). */
  readonly now?: () => string;
}

export function defaultCompileConfiguration(overrides: Partial<Omit<CompileConfiguration, 'schema'>> = {}): CompileConfiguration {
  return { schema: COMPILE_CONFIGURATION_SCHEMA, ocr: { mode: 'off' }, policy: 'default', ...overrides };
}

export function configurationDigest(config: CompileConfiguration): Digest {
  return digestOf(config);
}

/** The `compileSources` options for `config` and `runtime`. The only place options are built, for every surface. */
export function toCompileSourcesOptions(config: CompileConfiguration, runtime: CompileRuntime = {}): CompileSourcesOptions {
  const ocrOn = config.ocr.mode !== 'off' && runtime.pageTiers !== undefined && runtime.pageTiers.length > 0;
  let lexicon: CompileSourcesOptions['lexicon'];
  if (config.profile !== undefined && config.profile !== 'auto') {
    const profile = resolveDomainProfile(config.profile);
    if (profile === undefined) throw new Error(`unknown domain profile "${config.profile}"`);
    lexicon = profile.lexicon;
  }
  return {
    ...(config.domainHint !== undefined ? { domainHint: config.domainHint } : {}),
    ...(config.focusQuestion !== undefined ? { focusQuestion: config.focusQuestion } : {}),
    ...(lexicon !== undefined ? { lexicon } : {}),
    ...(config.profile === 'auto' ? { autoProfile: true } : {}),
    ...(config.precedence !== undefined && config.precedence.length > 0 ? { precedence: { order: config.precedence } } : {}),
    ...(config.connectors !== undefined && config.connectors.length > 0 ? { connectors: config.connectors } : {}),
    ...(config.confirmedRules !== undefined && config.confirmedRules.length > 0 ? { confirmedRules: config.confirmedRules } : {}),
    ...(config.policy === 'off' ? { policy: false as const } : {}),
    ...(ocrOn ? { pageTiers: runtime.pageTiers! } : {}),
    ...(ocrOn && runtime.extractionBudget !== undefined ? { extractionBudget: runtime.extractionBudget } : {}),
    ...(runtime.recoveryCache !== undefined ? { recoveryCache: runtime.recoveryCache } : {}),
    ...(runtime.now !== undefined ? { now: runtime.now } : {}),
  };
}

/** Whether the runtime can honour the configuration's OCR intent; a mismatch is reported in the artifact. */
export function runtimeMatches(config: CompileConfiguration, runtime: CompileRuntime): { readonly ok: boolean; readonly note?: string } {
  const hasTiers = runtime.pageTiers !== undefined && runtime.pageTiers.length > 0;
  if (config.ocr.mode !== 'off' && !hasTiers)
    return {
      ok: false,
      note: `the configuration asks for OCR (${config.ocr.mode}) but no recovery tier was supplied; unread pages stay unaccounted`,
    };
  return { ok: true };
}
