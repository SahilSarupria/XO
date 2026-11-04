import type { ClassificationEntry, ClassificationSpec } from '@xo/capability-layer';

/**
 * The OPERATOR's goods → commodity-class glossary for the Halvorsen desk (what a real customer would export from their TMS).
 *
 * Honesty notes (read before quoting any number that uses this):
 *  - The claims manual never says which goods belong to which class, so nothing here comes from the manual. Every entry is `operator`.
 *  - The terms were written as a general freight vocabulary, not copied from the generator's goods lists, but they were written
 *    knowing the task domain: a lookup score on the generated tasks is an UPPER BOUND, not evidence about unseen goods.
 *  - Claimant names are free text too ("Delacroix Foods"): terms must not be words that appear in them. See the test.
 */
const t = (value: string, terms: readonly string[]): ClassificationEntry[] =>
  terms.map((term) => ({ term, value, origin: 'operator', evidence: 'Halvorsen TMS commodity glossary (operator-supplied)' }));

export const FREIGHT_GLOSSARY_ENTRIES: readonly ClassificationEntry[] = [
  ...t('hazmat', [
    'lithium',
    'battery pack',
    'aerosol',
    'chemical',
    'paint thinner',
    'solvent',
    'flammable',
    'corrosive',
    'explosive',
    'compressed gas',
    'propane',
    'pesticide',
    'fuel',
    'bleach',
    'ammonia',
    'acid',
    'oxidizer',
    'fireworks',
  ]),
  ...t('perishable', [
    'frozen',
    'seafood',
    'dairy',
    'produce',
    'chilled',
    'fresh fruit',
    'vegetable',
    'meat',
    'ice cream',
    'vaccine',
    'cut flowers',
  ]),
  ...t('electronics', [
    'server',
    'laptop',
    'display panel',
    'led display',
    'network switch',
    'router',
    'monitor',
    'tablet',
    'circuit board',
    'semiconductor',
  ]),
  ...t('fragile_glass', ['glass', 'glassware', 'mirror', 'window unit', 'porcelain', 'ceramic', 'crystal']),
  ...t('general', [
    'steel',
    'auto accessories',
    'dry goods',
    'machine parts',
    'garden tools',
    'lumber',
    'fittings',
    'brick',
    'pallets of paper',
  ]),
];

export const FREIGHT_CLASSIFICATION: ClassificationSpec = {
  entries: FREIGHT_GLOSSARY_ENTRIES,
  highRisk: ['hazmat'],
  onConflict: { target: 'Claims Manager', reason_code: 'CLASSIFICATION_CONFLICT' },
};

/** The same glossary in the shape the compiler accepts. */
export const FREIGHT_GLOSSARY_INPUT = {
  entries: FREIGHT_GLOSSARY_ENTRIES.map((e) => ({
    term: e.term,
    value: e.value,
    ...(e.evidence !== undefined ? { note: e.evidence } : {}),
  })),
  highRisk: ['hazmat'],
  onConflict: { target: 'Claims Manager', reason_code: 'CLASSIFICATION_CONFLICT' },
} as const;
