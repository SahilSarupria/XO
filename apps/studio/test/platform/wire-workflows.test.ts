import { describe, expect, it } from 'vitest';
import { WireParseError } from '../../src/platform/wire';
import { parseWorkflowChanges, parseWorkflowDetail, parseWorkflowPage } from '../../src/platform/wire-workflows';

const summary = {
  workflowId: 'wfl_' + 'a'.repeat(32),
  name: 'Release',
  lifecycle: 'awaiting_approval',
  revision: 2,
  currentVersion: 1,
  pendingApprovals: 1,
  latestRun: { runId: 'run_1', state: 'waiting', startedAt: '2026-11-16T00:00:00.000Z' },
  conversationId: 'cnv_' + 'b'.repeat(32),
  paused: false,
  archived: false,
  updatedAt: '2026-11-16T00:00:00.000Z',
};

describe('UW-2 Workflow entity wire', () => {
  it('parses a page of compact summaries', () => {
    const page = parseWorkflowPage({ workflows: [summary], nextCursor: 'abc', changesCursor: '42' });
    expect(page.workflows[0]?.lifecycle).toBe('awaiting_approval');
    expect(page.workflows[0]?.conversationId).toBe(summary.conversationId);
    expect(page.nextCursor).toBe('abc');
  });

  it('refuses a lifecycle it does not know rather than showing it', () => {
    expect(() => parseWorkflowPage({ workflows: [{ ...summary, lifecycle: 'done-ish' }], changesCursor: '0' })).toThrow(WireParseError);
  });

  it('parses the detail; another member sees only that a conversation is linked', () => {
    const d = parseWorkflowDetail({
      ...summary,
      workspacePaused: false,
      origin: { via: 'conversation', conversation: { store: 'cnv', linked: true }, createdBy: { id: 'p', kind: 'human' }, createdAt: '' },
      currentVersion: {
        version: 1,
        definition: { definitionId: 'gwf_1' },
        goalText: 'Ship',
        certificate: { certificateId: 'wrc_1', status: 'READY', issuedAt: '' },
      },
      versions: [{}],
      pendingApprovals: [{ runId: 'run_1', approvalId: 'apr_1', step: 's1', summary: 'Pull the code' }],
      runs: [{ runId: 'run_1', version: 1, state: 'waiting', pendingApprovals: 1, startedAt: '' }],
      runsTotal: 1,
      history: [{ revision: 1, kind: 'created', at: '' }],
    });
    expect(d.origin.conversation).toEqual({ linked: true });
    expect(d.currentVersion.certificate?.status).toBe('READY');
    expect(d.pendingApprovals).toHaveLength(1);
  });

  it('parses the change feed and refuses an unknown kind', () => {
    expect(
      parseWorkflowChanges({ changes: [{ at: '', workflowId: 'w', kind: 'run', state: 'waiting', runId: 'r' }], cursor: '9' }).changes[0]
        ?.state,
    ).toBe('waiting');
    expect(() => parseWorkflowChanges({ changes: [{ at: '', workflowId: 'w', kind: 'other' }], cursor: '9' })).toThrow(WireParseError);
  });
});
