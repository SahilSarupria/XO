import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { classifyContent, classifySentenceKind } from '../../src/document/content-classification.js';

// Domain-neutral wording.
const cases: readonly [string, string][] = [
  ['A widget means a self-contained unit of work.', 'definition'],
  ['Severity 1 refers to a complete outage.', 'definition'],
  ['If the widget count exceeds 5, approve the request.', 'rule'],
  ['Requests above the limit require approval from the lead.', 'rule'],
  ['Entry must be denied when the badge is missing.', 'rule'],
  ['The operator must log the event within one hour.', 'obligation'],
  ['The supplier may suspend the service.', 'permission'],
  ['Staff must not open the panel.', 'prohibition'],
  ['The party must keep the data secret and must not disclose it.', 'prohibition'],
  ['If the stock level is below 10, reorder the item.', 'rule'],
  ['When the badge is missing, notify the guard.', 'rule'],
  ['If the study succeeds, results will be published.', 'obligation'],
  ['The study enrolled 240 participants across three sites.', 'reference'],
  ['Larger trials are needed to confirm these findings.', 'reference'],
  ['## 2. Escalation', 'heading'],
  ['3. Definitions', 'heading'],
];
for (const [text, kind] of cases) {
  test(`classifySentenceKind: "${text}" -> ${kind}`, () => assert.equal(classifySentenceKind(text), kind));
}

test('a research-style abstract has no normative content and a reference-dominant profile', () => {
  const p = classifyContent(['The study enrolled 240 participants across three sites. Participants showed a 12% reduction in symptoms. Larger trials are needed to confirm these findings.']);
  assert.equal(p.normativeCount, 0);
  assert.equal(p.dominantKind, 'reference');
});

test('a rules document is rule/obligation dominated with normative content, and headings are not counted as a dominant kind', () => {
  const p = classifyContent(['## 1. Entry\nIf the badge is missing, entry must be denied. If the badge is valid, approve the entry. The guard must log each visit.']);
  assert.ok(p.normativeCount >= 3);
  assert.equal(p.dominantKind, 'rule');
  assert.equal(p.counts.heading >= 1, true);
});

test('an empty profile is well-formed', () => {
  const p = classifyContent([]);
  assert.equal(p.total, 0);
  assert.equal(p.dominantKind, undefined);
});

test('compile reports a content profile per source; a non-rule source is reported as having no normative content', async () => {
  const ref = await compileSources([{ kind: 'document', text: '# Abstract\nThe study enrolled 240 participants across three sites. Participants showed a 12% reduction in symptoms.\n', sourcePath: 'abstract.md' }], {});
  assert.equal(ref.ok, true);
  if (ref.ok) assert.ok(ref.value.diagnostics.some((d) => d.code === 'document-profile/no-normative-content'));
  const rules = await compileSources([{ kind: 'document', text: '# Rules\n1.1 If the widget count exceeds 5, approve the request.\n', sourcePath: 'rules.md' }], {});
  assert.equal(rules.ok, true);
  if (rules.ok) assert.ok(rules.value.diagnostics.some((d) => d.code === 'document-profile/summary'));
});
