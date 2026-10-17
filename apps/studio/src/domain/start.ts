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
  /** Some of the lists above failed to load: do not recommend from partial facts. */
  readonly incomplete: boolean;
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
