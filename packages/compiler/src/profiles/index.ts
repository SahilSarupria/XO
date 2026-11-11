/**
 * Domain profiles: OPTIONAL vocabulary packs layered over the domain-neutral core for one compilation.
 *
 * The core grammar knows only generic language (status words, comparisons, durations, connectives). Anything that carries
 * subject-matter meaning belongs in a profile, selected explicitly by the caller — never inferred, never global. A profile
 * today extends the grammar's categorical state vocabulary; ontologies and validation rules can be added without touching
 * the core.
 */
import type { GrammarLexicon } from '@xo/capability-contract';

export interface DomainProfile {
  readonly id: string;
  readonly description: string;
  readonly lexicon: GrammarLexicon;
}

export const INSURANCE_CLAIMS_PROFILE: DomainProfile = {
  id: 'insurance-claims',
  description: 'Insurance policy / claims wording. Carries the two legacy claims words that predate the profile mechanism.',
  lexicon: { categoricalStates: ['flood', 'theft'] },
};

const PROFILES: Readonly<Record<string, DomainProfile>> = { [INSURANCE_CLAIMS_PROFILE.id]: INSURANCE_CLAIMS_PROFILE };

export function listDomainProfiles(): readonly DomainProfile[] {
  return Object.values(PROFILES);
}

/** Resolves a profile by id; `undefined` for an unknown id (callers must not silently fall back to some other domain). */
export function resolveDomainProfile(id: string): DomainProfile | undefined {
  return PROFILES[id];
}
