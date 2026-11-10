// Embedding the durable workflow runner in YOUR application, as a library (no CLI, no server, no model, no network).
// Public surfaces only: @xo/workflow-ir (the workflow format), @xo/connectors (how effects leave the process),
// @xo/workflow-runtime (the durable runner, journal, anchors).
//
//   node examples/host-app-demo/embed-workflow.mjs
//
// What you get: every step is journaled before and after it runs, so a crash resumes instead of repeating work; a destination that
// supports idempotency keys receives one key per step; anything the rules cannot decide is escalated to a person, never guessed;
// and run-end heads are anchored somewhere the runs directory's writer cannot edit, so truncation or rewriting is detectable.
// What you do not get: exactly-once delivery (a destination that lies or lags can still see a duplicate), a UI, or measured accuracy.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWorkflowComponent } from '@xo/workflow-ir';
import { ConnectorHost, MapVault } from '@xo/connectors';
import { AnchoredRunStore, RunStore, WorkflowRunner, verifyRunAnchors } from '@xo/workflow-runtime';

// 1. The workflow: data, not code. "Pay small claims automatically; escalate everything else to a person."
const component = {
  formatVersion: '1.0',
  semanticsVersion: '1.0',
  connectors: [{ id: 'ledger', kind: 'http', operations: [{ name: 'record', sideEffect: 'write' }] }],
  workflows: [
    {
      id: 'small_claims',
      version: '1.0.0',
      triggers: [{ id: 'api', kind: 'api' }],
      inputs: { amount: { type: 'number', required: true }, claim: { type: 'string', required: true } },
      steps: [
        {
          id: 'check',
          type: 'decide',
          determinism: 'deterministic',
          timeoutMs: 1000,
          inputs: { amount: { from: 'input.amount' } },
          method: { kind: 'rules', rules: [{ id: 'small', when: 'amount <= 1000', set: { verdict: 'pay' } }], onNoMatch: 'escalate' },
          outputs: { verdict: { type: 'enum', enum: ['pay'] } },
        },
        {
          id: 'record',
          type: 'act',
          determinism: 'deterministic',
          needs: ['check'],
          timeoutMs: 1000,
          connector: 'ledger',
          operation: 'record',
          sideEffect: 'write',
          inputs: { amount: { from: 'input.amount' } },
          idempotencyKey: 'record:{{input.claim}}',
        },
      ],
      maxConcurrency: 2,
      runTimeoutMs: 60_000,
      cancellation: { onCancel: 'abandon' },
      requiresFeatures: ['rules'],
    },
  ],
};
const verdict = validateWorkflowComponent(component);
if (verdict.issues.some((i) => i.severity === 'error')) throw new Error(`invalid workflow: ${JSON.stringify(verdict.issues)}`);

// 2. Your system, wrapped as a connector. `supports_key` is a CLAIM about your system: say it only if it really dedupes on the key.
const written = new Map();
const ledger = {
  kind: 'http',
  operations: {
    record: {
      sideEffect: 'write',
      idempotency: 'supports_key',
      execute: async (args, ctx) => {
        if (written.has(ctx.idempotencyKey)) return { id: written.get(ctx.idempotencyKey), duplicate: true };
        const id = `rec_${written.size + 1}`;
        written.set(ctx.idempotencyKey, id);
        return { id };
      },
    },
  },
};
const host = new ConnectorHost({
  component,
  policy: { connectors: { ledger: { grant: ['record'] } } }, // deny by default: only granted operations can be called
  implementations: { ledger },
  vault: new MapVault({}),
});

// 3. Durable state + anchors. The anchor sink must NOT be writable by whoever can write the runs directory (a WORM mount, another service).
const dir = await mkdtemp(join(tmpdir(), 'xo-embed-'));
const anchors = [];
const store = new AnchoredRunStore(new RunStore(join(dir, 'runs')), [{ id: 'memory', publish: async (a) => void anchors.push(a) }]);
const runner = new WorkflowRunner({ component, workflowId: 'small_claims', store, connectors: host });

// 4. Run. A small claim completes; a large one is escalated for a person (the run's state says so).
const small = await runner.start({ inputs: { amount: 250, claim: 'c-1' } });
const large = await runner.start({ inputs: { amount: 25_000, claim: 'c-2' } });
console.log(`c-1 (250):    ${small.state}`);
console.log(`c-2 (25000):  ${large.state}  <- needs a person; nothing was sent`);
console.log(`records written: ${[...written.values()].join(', ')}`);

// 5. Prove the history: the journal's chain is checked on read, and anchors catch a journal that was cut back or rebuilt.
const check = await verifyRunAnchors(new RunStore(join(dir, 'runs')), anchors);
console.log(
  `anchors: ${check.anchors} over ${check.runs} run(s) -> ${check.ok ? 'every anchored position matches' : check.problems.join('; ')}`,
);
console.log(
  `journal for c-1 (${small.runId}):\n${(await readFile(join(dir, 'runs', small.runId, 'journal.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => '  ' + JSON.parse(l).type)
    .join('\n')}`,
);
