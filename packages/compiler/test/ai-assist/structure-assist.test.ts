/**
 * UW-3b (H) — optional structure assistance: off by default, residency-gated, shape-only unless text egress is allowed,
 * and every proposal checked against the deterministic evidence. Nothing is ever applied to the document.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResidencyPolicy } from '@xo/ai-core';
import { DocumentSourceFrontend } from '../../src/sources/document-frontend.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';
import {
  assistStructure,
  proposalProblems,
  unroutedSectionShapes,
  type SectionShape,
  type StructureAssistProvider,
} from '../../src/ai-assist/structure-assist.js';
import type { ExperienceDocument } from '../../src/semantic/types.js';

const STRICT: ResidencyPolicy = { mode: 'strict_local', contractedProviders: [] };
const MASKED: ResidencyPolicy = { mode: 'masked_hosted', contractedProviders: ['anthropic'] };
const OPEN: ResidencyPolicy = { mode: 'open', contractedProviders: [] };

// Unrouted on purpose: two bullet items, only one of which reads as an instruction, under a neutral heading.
const TEXT = '## Notes\n\n- Restart the gateway after the update.\n- The gateway lives in rack 4.\n';

async function doc(): Promise<ExperienceDocument> {
  const ingested = new DocumentSourceFrontend().ingest({ kind: 'document', text: TEXT, sourcePath: 'notes.md' });
  assert.ok(ingested.ok && ingested.value.content.kind === 'document');
  return chunkDocument(ingested.value.content.parsed, 'notes.md', undefined);
}

function provider(locality: 'local' | 'hosted', answer: (s: readonly SectionShape[]) => { sectionId: string; kind: string }[]) {
  const seen: (readonly SectionShape[])[] = [];
  const p: StructureAssistProvider = {
    providerId: locality === 'local' ? 'ollama' : 'anthropic',
    locality,
    proposeSectionKinds: async (sections) => {
      seen.push(sections);
      return answer(sections);
    },
  };
  return { p, seen };
}

test('off by default: no provider, no call', async () => {
  const r = await assistStructure(await doc(), undefined, { residency: OPEN });
  assert.equal(r.status, 'not_called');
  assert.deepEqual(r.proposals, []);
});

test('strict_local never calls a hosted provider', async () => {
  const { p, seen } = provider('hosted', () => []);
  const r = await assistStructure(await doc(), p, { residency: STRICT, includeText: true });
  assert.equal(r.status, 'denied');
  assert.equal(seen.length, 0);
});

test('masked_hosted sends shape only, never text, even when text is requested', async () => {
  const { p, seen } = provider('hosted', (s) => [{ sectionId: s[0]!.sectionId, kind: 'guideline' }]);
  const r = await assistStructure(await doc(), p, { residency: MASKED, includeText: true });
  assert.equal(r.status, 'completed');
  assert.equal(r.textSent, false);
  const sent = JSON.stringify(seen);
  assert.ok(!sent.includes('gateway') && !sent.includes('Notes'), 'no document text left the instance');
  assert.equal(seen[0]![0]!.unorderedItems, 2);
});

test('a proposal the evidence cannot carry is rejected; one it can is validated but not applied', async () => {
  const { p } = provider('local', (s) => [
    { sectionId: s[0]!.sectionId, kind: 'procedure' },
    { sectionId: s[0]!.sectionId, kind: 'guideline' },
    { sectionId: 'nope', kind: 'checklist' },
    { sectionId: s[0]!.sectionId, kind: 'execute everything' },
  ]);
  const before = await doc();
  const r = await assistStructure(before, p, { residency: STRICT, includeText: true });
  assert.equal(r.status, 'completed');
  assert.equal(r.textSent, true, 'a local provider may see text');
  assert.deepEqual(
    r.proposals.map((x) => [x.kind, x.validation]),
    [
      ['procedure', 'rejected'],
      ['guideline', 'validated'],
      ['checklist', 'rejected'],
      ['execute everything', 'rejected'],
    ],
  );
  assert.ok(
    before.units.every((u) => u.structure === undefined),
    'the document is never changed',
  );
});

test('a failing provider fails closed', async () => {
  const p: StructureAssistProvider = {
    providerId: 'ollama',
    locality: 'local',
    proposeSectionKinds: () => Promise.reject(new Error('down')),
  };
  const r = await assistStructure(await doc(), p, { residency: OPEN });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.proposals, []);
});

test('shape helpers: only unrouted structured sections are described, and evidence rules are explicit', async () => {
  const shapes = unroutedSectionShapes(await doc(), false);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0]!.heading, undefined);
  assert.deepEqual(proposalProblems({ ...shapes[0]!, formFields: 0 }, 'form'), ['a form needs at least three fields']);
});
