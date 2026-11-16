/** PX-7 (gap PX-G25) — a sign-off binds to what each step IS: a changed contract under the same ids makes it stale. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '../src/workflow-controls/model.js';

test('the sign-off identity changes when a step contract changes, even with the same ids and order', () => {
  const steps = [
    { order: 0, capabilityId: 'cap_a', contractHash: 'sha256:aaa' },
    { order: 1, capabilityId: 'cap_b', contractHash: 'sha256:bbb' },
  ];
  const v = { compilationId: 'cmp_1', workflowId: 'wf_1', steps };
  assert.equal(contentHash(v), contentHash({ ...v, steps: steps.map((s) => ({ ...s })) }));
  assert.notEqual(contentHash(v), contentHash({ ...v, steps: [steps[0]!, { ...steps[1]!, contractHash: 'sha256:changed' }] }));
  assert.notEqual(contentHash(v), contentHash({ ...v, steps: [...steps].reverse().map((s, i) => ({ ...s, order: i })) }));
});
