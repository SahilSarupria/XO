import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DocumentSourceFrontend, proposeDocumentKinds } from '@xo/compiler';
import { contentHash, type Suite, type SuiteResult } from '../src/index.js';

interface KindCase {
  readonly id: string;
  readonly text: string;
  readonly expected: string | null;
}

/** Whether XO proposes the right kind for a document from its content alone. The certificate vertical starts here. */
export const documentKindsSuite: Suite = {
  id: 'document-kinds',
  title: 'Proposing what kind of document a source is',
  async run(): Promise<SuiteResult> {
    const set = JSON.parse(readFileSync(fileURLToPath(new URL('../sets/document-kinds.json', import.meta.url)), 'utf8')) as {
      id: string;
      version: string;
      provenance: 'synthetic' | 'real';
      description: string;
      cases: KindCase[];
    };
    const frontend = new DocumentSourceFrontend();
    let labelled = 0;
    let top1 = 0;
    let unlabelled = 0;
    let abstained = 0;
    let certTp = 0;
    let certFp = 0;
    let certFn = 0;
    const misses: string[] = [];
    for (const c of set.cases) {
      // A file name with no cue, so only the content decides.
      const r = frontend.ingest({ kind: 'document', text: c.text, sourcePath: `${c.id}.txt` });
      if (!r.ok) throw new Error(`${c.id}: ${r.error.message}`);
      const got = proposeDocumentKinds(r.value)[0]?.kind ?? null;
      if (c.expected === null) {
        unlabelled++;
        if (got === null) abstained++;
        else misses.push(`${c.id}: proposed ${got}, expected none`);
      } else {
        labelled++;
        if (got === c.expected) top1++;
        else misses.push(`${c.id}: proposed ${got ?? 'none'}, expected ${c.expected}`);
      }
      if (got === 'certificate' && c.expected === 'certificate') certTp++;
      else if (got === 'certificate') certFp++;
      else if (c.expected === 'certificate') certFn++;
    }
    const r = (n: number, d: number) => (d === 0 ? null : n / d);
    return {
      suite: 'document-kinds',
      title: 'Proposing what kind of document a source is',
      uac: ['UAC-19'],
      mode: 'deterministic',
      sets: [
        {
          id: set.id,
          version: set.version,
          provenance: set.provenance,
          cases: set.cases.length,
          contentHash: contentHash(set.cases),
          description: set.description,
        },
      ],
      measures: [
        {
          id: 'document-kinds/top1-accuracy',
          title: 'Right kind proposed first',
          unit: 'ratio',
          better: 'higher',
          value: r(top1, labelled),
          numerator: top1,
          denominator: labelled,
        },
        {
          id: 'document-kinds/abstention',
          title: 'No kind proposed when none applies',
          unit: 'ratio',
          better: 'higher',
          value: r(abstained, unlabelled),
          numerator: abstained,
          denominator: unlabelled,
        },
        {
          id: 'document-kinds/certificate-precision',
          title: 'Certificate precision',
          unit: 'ratio',
          better: 'higher',
          value: r(certTp, certTp + certFp),
          numerator: certTp,
          denominator: certTp + certFp,
        },
        {
          id: 'document-kinds/certificate-recall',
          title: 'Certificate recall',
          unit: 'ratio',
          better: 'higher',
          value: r(certTp, certTp + certFn),
          numerator: certTp,
          denominator: certTp + certFn,
        },
      ],
      notes: misses.length > 0 ? [`Missed: ${misses.join('; ')}.`] : [],
      limits: [
        'A small synthetic set written with the cue pack in view; it shows the mechanism works, not how it does on real documents.',
        'Kinds are proposals for a person to confirm, never decisions; this measures the proposal only.',
      ],
    };
  },
};
