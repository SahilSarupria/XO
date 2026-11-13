import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash, type Suite, type SuiteResult } from '../src/index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Where the injection corpus (UW-1, UAC-17) is enforced today: each test file checks one path documents reach. */
const CHECKS = [
  'packages/compiler/test/reasoning/injection-corpus.test.ts',
  'packages/intelligence/test/injection-corpus.test.ts',
  'packages/workflow-runtime/test/injection-corpus.test.ts',
] as const;

/** UAC-17 — the injection corpus never changes composition, recipients or approvals, on every path that checks it. */
export const injectionCorpusSuite: Suite = {
  id: 'injection-corpus',
  title: 'Prompt injection in documents',
  slow: true,
  async run(): Promise<SuiteResult> {
    const corpus = JSON.parse(readFileSync(`${ROOT}specs/security/injection-corpus.json`, 'utf8')) as { cases: { id: string }[] };
    let pass = 0;
    let total = 0;
    const notes: string[] = [];
    // A child of a running test runner inherits NODE_TEST_CONTEXT and reports to it instead of printing TAP: clear it.
    const env = { ...process.env };
    delete env['NODE_TEST_CONTEXT'];
    for (const file of CHECKS) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', file], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 300_000,
        env,
      });
      const passed = Number(/^# pass (\d+)/m.exec(r.stdout)?.[1] ?? 0);
      const failed = Number(/^# fail (\d+)/m.exec(r.stdout)?.[1] ?? 0);
      if (passed + failed === 0) notes.push(`${file}: did not run (${(r.stderr || 'no output').slice(0, 120)})`);
      pass += passed;
      total += passed + failed;
      if (failed > 0) notes.push(`${file}: ${failed} failing`);
    }
    return {
      suite: 'injection-corpus',
      title: 'Prompt injection in documents',
      uac: ['UAC-17'],
      mode: 'deterministic',
      sets: [
        {
          id: 'injection-corpus',
          version: '1',
          provenance: 'synthetic',
          cases: corpus.cases.length,
          contentHash: contentHash(corpus),
          description: 'specs/security/injection-corpus.json (UW-1).',
        },
      ],
      measures: [
        {
          id: 'injection-corpus/structural-checks',
          title: 'Structural checks passing across compiler, intelligence and workflow runtime',
          unit: 'ratio',
          better: 'higher',
          value: total === 0 ? null : pass / total,
          numerator: pass,
          denominator: total,
        },
      ],
      notes,
      limits: [
        'Structural checks: where a payload sits, that it cannot escape its frame, that an obeying answer is refused or needs a person. How often a live model is misled is not measured here.',
        'Chat as an injection channel is covered by the intelligence suite’s security items, not by this corpus.',
      ],
    };
  },
};
