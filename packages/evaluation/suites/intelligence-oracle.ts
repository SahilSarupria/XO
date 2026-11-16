import { buildReport, CATEGORIES, DATASET, OracleModel, runEval } from '@xo/intelligence-eval';
import { contentHash, type Measure, type Suite, type SuiteResult } from '../src/index.js';

/**
 * The customer-intelligence evaluation (packages/intelligence-eval) in oracle mode: a deterministic stand-in model answers, so this
 * measures everything around the model (retrieval, authorization, citations, routing) and not the model itself.
 */
export const intelligenceOracleSuite: Suite = {
  id: 'intelligence-oracle',
  title: 'Customer intelligence, with a stand-in model',
  async run(): Promise<SuiteResult> {
    const results = await runEval({ model: new OracleModel(DATASET), items: DATASET, concurrency: 1 });
    const report = buildReport(results, { mode: 'oracle', model: 'oracle', knowledgeSource: 'fixture corpus' });
    // As the evaluation's own gates do: items marked as known limits are reported in the notes, not counted against the category.
    const measures: Measure[] = CATEGORIES.map((c) => {
      const s = report.categories[c];
      return {
        id: `intelligence-oracle/${c}`,
        title: `${c[0]!.toUpperCase()}${c.slice(1)} items passing${s.knownLimitTotal > 0 ? ` (${s.knownLimitTotal} known limits excluded)` : ''}`,
        unit: 'ratio',
        better: 'higher',
        value: s.gatedPassRate,
        numerator: s.gatedPassed,
        denominator: s.gatedTotal,
      };
    });
    measures.push({
      id: 'intelligence-oracle/restricted-leaks',
      title: 'Restricted content reaching an answer or a prompt',
      unit: 'count',
      better: 'lower',
      value: report.metrics.securityFailures,
    });
    return {
      suite: 'intelligence-oracle',
      title: 'Customer intelligence, with a stand-in model',
      uac: ['UAC-17', 'UAC-19'],
      mode: 'deterministic',
      sets: [
        {
          id: 'intelligence-dataset',
          version: '1',
          provenance: 'synthetic',
          cases: DATASET.length,
          contentHash: contentHash(DATASET),
          description: 'The intelligence evaluation dataset and fixture corpus (packages/intelligence-eval).',
        },
      ],
      measures,
      notes:
        report.failures.length > 0
          ? [`Failing items: ${report.failures.map((f) => `${f.id}${f.knownLimit ? ' (known limit)' : ''}`).join(', ')}.`]
          : [],
      limits: [
        'Oracle mode: the answers come from a deterministic stand-in. Live-model evaluation (Q1) runs through `npm run eval -w @xo/intelligence-eval -- --mode live` and is not part of this report.',
        'A synthetic organisation; no real customer corpus.',
      ],
    };
  },
};
