import type { Status } from '../ui/kit';
import type { WorkflowDetailView, WorkflowLifecycle, WorkflowSummaryView } from '../platform/wire-workflows';

/** The platform's lifecycle of a workflow, in the one status vocabulary. An unknown state is shown as its own words, never guessed. */
export function workflowStatus(w: { readonly lifecycle: WorkflowLifecycle; readonly paused: boolean; readonly archived: boolean }): Status {
  if (w.archived || w.lifecycle === 'archived') return 'cancelled';
  if (w.paused || w.lifecycle === 'paused') return 'paused';
  switch (w.lifecycle) {
    case 'draft':
      return 'draft';
    case 'ready':
      return 'ready';
    case 'awaiting_approval':
      return 'waiting';
    case 'running':
      return 'running';
    case 'needs_attention':
      return 'attention';
    case 'completed':
      return 'done';
    case 'partially_completed':
      return 'partial';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/** What the person can do next, in one sentence. The platform decides whether it is allowed; this only says what is the next thing. */
export function nextStep(w: WorkflowDetailView): string {
  if (w.archived) return 'This workflow is archived. Restore it to use it again.';
  if (w.workspacePaused) return 'Everything in this workspace is paused. Resume it in Settings first.';
  if (w.paused) return 'This workflow is paused. Resume it to start work again.';
  if (w.pendingApprovals.length > 0)
    return `${w.pendingApprovals.length === 1 ? 'One decision waits' : `${w.pendingApprovals.length} decisions wait`} for a person in the Inbox.`;
  switch (w.lifecycle) {
    case 'draft':
      return 'XO is still setting this up. It needs a check before it can start.';
    case 'ready':
      return 'It is ready. Start it when you want it to run.';
    case 'running':
      return 'It is running now.';
    case 'needs_attention':
      return 'Something needs your attention. See the latest run.';
    case 'failed':
      return 'The last run did not complete. See what happened, then start it again.';
    case 'completed':
    case 'partially_completed':
      return 'The last run finished. Start it again when you need it.';
    default:
      return 'Start it when you want it to run.';
  }
}

export const listStatus = (w: WorkflowSummaryView): Status => workflowStatus(w);
