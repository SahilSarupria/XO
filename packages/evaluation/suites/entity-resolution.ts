import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveEntities, type Cardinality, type ResolutionItem } from '@xo/knowledge-base';
import { contentHash, type Suite, type SuiteResult } from '../src/index.js';

interface Case {
  readonly id: string;
  readonly category: string;
  readonly cardinality: Cardinality;
  readonly subjects: readonly ResolutionItem[];
  readonly candidates: readonly ResolutionItem[];
  /** Per subject ref: `resolved:<c1,c2>`, `ambiguous` or `unmatched`. */
  readonly expected: Readonly<Record<string, string>>;
}

/** UW-5 / UAC-19: identity resolution measured on a labelled homonym/alias set. A wrong-identity confirmation is the failure that matters. */
export const entityResolutionSuite: Suite = {
  id: 'entity-resolution',
  title: 'Resolving people and records across sources',
  async run(): Promise<SuiteResult> {
    const set = JSON.parse(readFileSync(fileURLToPath(new URL('../sets/entity-resolution.json', import.meta.url)), 'utf8')) as {
      id: string;
      version: string;
      provenance: 'synthetic' | 'real';
      description: string;
      cases: Case[];
    };
    let expectedResolved = 0;
    let systemResolved = 0;
    let correct = 0;
    let wrongIdentity = 0;
    let ambiguityKept = 0;
    let ambiguityExpected = 0;
    const misses: string[] = [];
    for (const c of set.cases) {
      const report = resolveEntities(
        { relationship: c.id, cardinality: c.cardinality, strongSchemes: { email: 'email' } },
        c.subjects,
        c.candidates,
      );
      for (const r of report.results) {
        const want = c.expected[r.subject] ?? 'unmatched';
        const got = r.outcome === 'resolved' ? `resolved:${r.candidates.map((x) => x.candidate).sort().join(',')}` : r.outcome;
        if (want.startsWith('resolved')) expectedResolved++;
        else if (want === 'ambiguous') ambiguityExpected++;
        if (r.outcome === 'resolved') {
          systemResolved++;
          if (got === want) correct++;
          else {
            wrongIdentity++;
            misses.push(`${c.id}/${r.subject} (${c.category}): got ${got}, expected ${want}`);
          }
        } else if (want === 'ambiguous' && r.outcome === 'ambiguous') ambiguityKept++;
        else if (got !== want) misses.push(`${c.id}/${r.subject} (${c.category}): got ${got}, expected ${want}`);
      }
    }
    const r = (n: number, d: number) => (d === 0 ? null : n / d);
    return {
      suite: 'entity-resolution',
      title: 'Resolving people and records across sources',
      uac: ['UAC-5', 'UAC-19'],
      mode: 'deterministic',
      sets: [
        { id: set.id, version: set.version, provenance: set.provenance, cases: set.cases.length, contentHash: contentHash(set.cases), description: set.description },
      ],
      measures: [
        { id: 'entity-resolution/precision', title: 'Resolved results that are the right match', unit: 'ratio', better: 'higher', value: r(correct, systemResolved), numerator: correct, denominator: systemResolved },
        { id: 'entity-resolution/recall', title: 'Right matches that were resolved', unit: 'ratio', better: 'higher', value: r(correct, expectedResolved), numerator: correct, denominator: expectedResolved },
        { id: 'entity-resolution/wrong-identity-confirmations', title: 'Wrong-identity confirmations', unit: 'count', better: 'lower', value: wrongIdentity },
        { id: 'entity-resolution/ambiguity-kept', title: 'Ambiguous cases left ambiguous', unit: 'ratio', better: 'higher', value: r(ambiguityKept, ambiguityExpected), numerator: ambiguityKept, denominator: ambiguityExpected },
      ],
      notes: misses.length > 0 ? [`Missed: ${misses.join('; ')}.`] : [],
      limits: [
        'Synthetic set written with the matcher tiers in view: it shows the rules hold, not how real name lists behave.',
        'Thresholds ratified 2026-11-17 by owner delegation (handoff section 10); the labelled set is synthetic.',
        'Names in non-Latin scripts and real transliteration variety are not covered.',
      ],
    };
  },
};
