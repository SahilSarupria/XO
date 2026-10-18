/**
 * "Start work": the supported things a person can do next in this workspace, derived ONLY from facts the platform
 * reported (documents, analyses, rule approvals, workflows, waiting decisions). It is not a task resolver: nothing
 * here interprets free text or invents an action XO cannot perform. Pure logic: no React, no requests.
 */
export type StartTarget = 'documents' | 'rules' | 'workflows' | 'tasks';

export interface StartAction {
  readonly id: 'decide' | 'start-process' | 'review-rules' | 'analyse' | 'add-document';
  readonly title: string;
  readonly detail: string;
  readonly target: StartTarget;
}

export interface StartFacts {
  readonly sources: number;
  readonly succeededCompilations: number;
  /** Rules found in the current analysis that are waiting for a person's approval. */
  readonly readyForReview: number;
  /** Processes that can be started right now (approved, runnable, none already active). */
  readonly readyWorkflows: number;
  /** Decisions waiting for a person (including stopped processes that can be continued). */
  readonly waitingDecisions: number;
  /** Processes that exist and could run once their rules are approved. */
  readonly blockedWorkflows: number;
  /** Processes currently running (not waiting for a person, not stopped). */
  readonly activeRuns: number;
  /** Some of the lists above failed to load: do not recommend from partial facts. */
  readonly incomplete: boolean;
}

export interface UnavailableAction {
  readonly id: StartAction['id'];
  readonly title: string;
  /** Why it cannot be done right now, in plain words, from the same facts as the available list. */
  readonly reason: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Ordered by how useful each action is right now; the first entry is the recommended one. */
export function startActions(f: StartFacts): StartAction[] {
  const out: StartAction[] = [];
  const addDocument = (title: string, detail: string): StartAction => ({ id: 'add-document', title, detail, target: 'documents' });

  if (f.incomplete) {
    // Only an action that does not depend on the missing information is safe to offer.
    return [addDocument('Add a document', 'Upload a procedure, guideline or rulebook your team already uses.')];
  }
  if (f.waitingDecisions > 0)
    out.push({
      id: 'decide',
      title: f.waitingDecisions === 1 ? 'Review a waiting decision' : `Review ${f.waitingDecisions} waiting decisions`,
      detail: 'A process is paused until a person decides.',
      target: 'tasks',
    });
  if (f.readyWorkflows > 0)
    out.push({
      id: 'start-process',
      title: 'Start a process',
      detail: `${f.readyWorkflows} ${plural(f.readyWorkflows, 'process is', 'processes are')} ready to run.`,
      target: 'workflows',
    });
  if (f.readyForReview > 0)
    out.push({
      id: 'review-rules',
      title: 'Review what XO found',
      detail: `${f.readyForReview} ${plural(f.readyForReview, 'rule is', 'rules are')} waiting for your approval. Nothing runs until you approve.`,
      target: 'rules',
    });
  if (f.sources > 0 && f.succeededCompilations === 0)
    out.push({
      id: 'analyse',
      title: 'Analyse your document',
      detail: 'XO reads it and lists the rules it finds, with the evidence for each.',
      target: 'documents',
    });
  out.push(
    f.sources === 0
      ? addDocument('Add your first document', 'Upload a procedure, guideline or rulebook. XO reads it and finds the rules inside.')
      : addDocument('Add another document', 'More documents give XO more rules to find.'),
  );
  return out;
}

/**
 * What cannot be done right now, and why. Shown so a missing option is explained rather than silently absent.
 * Empty when the facts are incomplete: a reason computed from missing data would be a guess.
 */
export function unavailableActions(f: StartFacts): UnavailableAction[] {
  if (f.incomplete) return [];
  const out: UnavailableAction[] = [];
  if (f.waitingDecisions === 0)
    out.push({ id: 'decide', title: 'Review a waiting decision', reason: 'Nothing is waiting for a decision.' });
  if (f.readyWorkflows === 0) {
    const reason =
      f.blockedWorkflows > 0
        ? f.blockedWorkflows === 1
          ? '1 process needs its rules approved first.'
          : `${f.blockedWorkflows} processes need their rules approved first.`
        : f.activeRuns > 0
          ? 'A process is already running.'
          : f.succeededCompilations === 0
            ? 'XO needs an analysed document first, so it has rules to build a process from.'
            : 'No process from your latest analysis can be started yet.';
    out.push({ id: 'start-process', title: 'Start a process', reason });
  }
  if (f.readyForReview === 0)
    out.push({
      id: 'review-rules',
      title: 'Review what XO found',
      reason: f.succeededCompilations === 0 ? 'Nothing has been analysed yet.' : 'No rules are waiting for your approval.',
    });
  if (f.sources === 0) out.push({ id: 'analyse', title: 'Analyse your document', reason: 'Add a document first.' });
  return out;
}
