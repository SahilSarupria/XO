import type { AutomationEngine } from './engine.js';

/** Prometheus text exposition (v0.0.4) of an engine's counters and queue state. No labels from user data, so cardinality is fixed. */
export function renderMetrics(engine: Pick<AutomationEngine, 'counters' | 'queueDepth' | 'activeJobs' | 'ledgerEntries'>): string {
  const c = engine.counters;
  const m = (name: string, help: string, type: 'counter' | 'gauge', value: number): string[] => [
    `# HELP xo_${name} ${help}`,
    `# TYPE xo_${name} ${type}`,
    `xo_${name} ${value}`,
  ];
  return (
    [
      ...m('jobs_accepted_total', 'Events accepted for execution.', 'counter', c.accepted),
      ...m('jobs_completed_total', 'Jobs that finished (any disposition).', 'counter', c.completed),
      ...m('jobs_failed_total', 'Jobs that exhausted retries or failed permanently (dead-lettered).', 'counter', c.failed),
      ...m('jobs_retried_total', 'Retry attempts.', 'counter', c.retries),
      ...m('jobs_duplicate_total', 'Events dropped as duplicates of an already-seen idempotency key.', 'counter', c.duplicates),
      ...m('queue_depth', 'Jobs waiting to start.', 'gauge', engine.queueDepth),
      ...m('jobs_active', 'Jobs running now.', 'gauge', engine.activeJobs),
      ...m('ledger_entries', 'Entries in the audit ledger.', 'gauge', engine.ledgerEntries.length),
    ].join('\n') + '\n'
  );
}
