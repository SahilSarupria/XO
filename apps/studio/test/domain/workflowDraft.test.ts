import { describe, expect, it } from 'vitest';
import { clip, draftFromWorkflow, MAX_DRAFT_NAME, MAX_NODE_LABEL } from '../../src/domain/workflowDraft';
import type { Capability, Workflow } from '../../src/platform/wire';

const long =
  'Record incoming payments which typically include TDS, then 2 more steps and a very long tail that goes on and on and on past any sensible limit';
const wf = (name: string, stepName = name): Workflow =>
  ({ workflowId: 'w', compilationId: 'cmp', name, steps: [{ capabilityId: 'cap_h', name: stepName, order: 0 }] }) as unknown as Workflow;
const caps = [{ capabilityId: 'cap_h', executionClass: 'human_in_the_loop' } as unknown as Capability];

describe("draftFromWorkflow stays inside the platform's limits (found by the real API, not the fakes)", () => {
  it('cuts a long process name, step labels and package label instead of producing a draft the platform rejects', () => {
    const d = draftFromWorkflow(wf(long.repeat(3)), caps);
    expect(d.name.length).toBeLessThanOrEqual(MAX_DRAFT_NAME);
    expect(d.name.endsWith(' (draft)')).toBe(true);
    for (const n of d.nodes) expect((n.label ?? '').length).toBeLessThanOrEqual(MAX_NODE_LABEL);
    expect(String(d.nodes[1]!.config['packageName']).length).toBeLessThanOrEqual(200);
    expect(d.nodes.map((n) => n.kind)).toEqual(['trigger', 'capability', 'human_review']);
  });
  it('leaves short names untouched', () => {
    expect(draftFromWorkflow(wf('Claims'), caps).name).toBe('Claims (draft)');
    expect(clip('abc', 3)).toBe('abc');
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});
