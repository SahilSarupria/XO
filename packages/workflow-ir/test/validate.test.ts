import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WORKFLOW_SCHEMA, validateWorkflowComponent, type WorkflowComponent, type WorkflowIssue } from '../src/index.js';

/** A small, valid document used as the base for mutation tests. */
function base(): any {
  return {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [
      {
        id: 'mail',
        kind: 'smtp',
        operations: [
          { name: 'send', sideEffect: 'write', secrets: ['SMTP_PASSWORD'] },
          { name: 'peek', sideEffect: 'read' },
        ],
      },
    ],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { amount: { type: 'number', required: true }, who: { type: 'string', required: true } },
        steps: [
          {
            id: 'check',
            type: 'decide',
            determinism: 'deterministic',
            inputs: { amount: { from: 'input.amount' } },
            method: {
              kind: 'rules',
              rules: [{ id: 'big', when: 'amount > 100', set: { tier: 'high' } }],
              onNoMatch: 'default',
              default: { tier: 'low' },
            },
            outputs: { tier: { type: 'enum', enum: ['high', 'low'] } },
            timeoutMs: 1000,
          },
          {
            id: 'notify',
            type: 'act',
            determinism: 'deterministic',
            needs: ['check'],
            inputs: { tier: { from: 'steps.check.tier' }, who: { from: 'input.who' } },
            connector: 'mail',
            operation: 'send',
            sideEffect: 'write',
            idempotencyKey: 'notify:{{run.id}}:{{input.who}}',
            timeoutMs: 5000,
          },
        ],
        maxConcurrency: 2,
        runTimeoutMs: 60000,
        cancellation: { onCancel: 'abandon' },
        requiresFeatures: ['rules'],
      },
    ],
  };
}

const codes = (doc: unknown): string[] =>
  validateWorkflowComponent(doc)
    .issues.filter((i) => i.severity === 'error')
    .map((i: WorkflowIssue) => i.code);
const mutate = (fn: (d: any) => void): any => {
  const d = base();
  fn(d);
  return d;
};

describe('Workflow IR validation (fail closed)', () => {
  it('accepts a well-formed document', () => {
    const v = validateWorkflowComponent(base());
    assert.deepEqual(
      v.issues.filter((i) => i.severity === 'error'),
      [],
    );
    assert.equal(v.valid, true);
  });

  it('refuses an unknown step type with the allowed list', () => {
    const d = mutate((x) => (x.workflows[0].steps[0].type = 'run_shell'));
    const v = validateWorkflowComponent(d);
    assert.equal(v.valid, false);
    assert.match(v.issues[0]?.message ?? '', /unknown type .*run_shell.*allowed: extract, decide, act/);
  });

  it('refuses unknown fields everywhere (no extension points in 1.0)', () => {
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[0].script = 'process.exit()'))).includes('SCHEMA'));
    assert.ok(codes(mutate((x) => (x.vendor = {}))).includes('SCHEMA'));
  });

  it('refuses a step with side effects and no idempotency key', () => {
    assert.ok(codes(mutate((x) => delete x.workflows[0].steps[1].idempotencyKey)).includes('MISSING_IDEMPOTENCY_KEY'));
  });

  it('refuses a constant idempotency key (it would dedupe every run into one)', () => {
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[1].idempotencyKey = 'notify'))).includes('CONSTANT_IDEMPOTENCY_KEY'));
  });

  it('does not demand keys on read steps, and refuses keys where they mean nothing (approval identity is derived)', () => {
    const readOnly = mutate((x) => {
      x.workflows[0].steps[1].operation = 'peek';
      x.workflows[0].steps[1].sideEffect = 'read';
      delete x.workflows[0].steps[1].idempotencyKey;
    });
    assert.deepEqual(codes(readOnly), []);
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[0].idempotencyKey = 'k:{{run.id}}'))).includes('KEY_NOT_ALLOWED'));
  });

  it('refuses a missing timeout', () => {
    assert.ok(codes(mutate((x) => delete x.workflows[0].steps[0].timeoutMs)).includes('SCHEMA'));
  });

  it('refuses cycles, including self-dependency', () => {
    const cyc = mutate((x) => (x.workflows[0].steps[0].needs = ['notify']));
    assert.ok(codes(cyc).includes('CYCLE'));
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[0].needs = ['check']))).includes('SELF_DEPENDENCY'));
  });

  it('refuses a read of a step that is not (transitively) needed', () => {
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[1].needs = []))).includes('UNORDERED_REF'));
  });

  it('refuses undeclared connectors and operations, and side-effect misdeclaration', () => {
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[1].connector = 'ghost'))).includes('UNDECLARED_CONNECTOR'));
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[1].operation = 'delete_all'))).includes('UNDECLARED_OPERATION'));
    // an author cannot launder a write as a read to dodge the idempotency rule
    const laundered = mutate((x) => {
      x.workflows[0].steps[1].sideEffect = 'read';
      delete x.workflows[0].steps[1].idempotencyKey;
    });
    assert.ok(codes(laundered).includes('SIDE_EFFECT_MISMATCH'));
  });

  it('refuses a model-backed or human step that claims to be deterministic', () => {
    const d = mutate((x) => {
      x.workflows[0].steps.push({
        id: 'ask',
        type: 'approve',
        determinism: 'deterministic',
        needs: ['check'],
        roles: ['reviewer'],
        summary: 'ok?',
        onTimeout: 'escalate',
        outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'] } },
        timeoutMs: 1000,
      });
      x.workflows[0].requiresFeatures = ['approve', 'rules'];
    });
    assert.ok(codes(d).includes('DETERMINISM_MISMATCH'));
  });

  it('has no auto-approve: onTimeout other than escalate is a schema error', () => {
    const d = mutate((x) => {
      x.workflows[0].steps.push({
        id: 'ask',
        type: 'approve',
        determinism: 'human',
        needs: ['check'],
        roles: ['reviewer'],
        summary: 'ok?',
        onTimeout: 'approve',
        outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'] } },
        timeoutMs: 1000,
      });
    });
    assert.ok(codes(d).includes('SCHEMA'));
  });

  it('refuses secrets, host paths and endpoints embedded in the document', () => {
    assert.ok(
      codes(mutate((x) => (x.workflows[0].steps[1].inputs.who = { const: 'sk-abcdefghijklmnopqrstuvwxyz012345' }))).includes(
        'SECRET_IN_DOCUMENT',
      ),
    );
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[1].inputs.who = { const: '/etc/passwd' }))).includes('HOST_PATH'));
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[1].inputs.who = { const: 'C:\\Users\\x\\secrets.txt' }))).includes('HOST_PATH'));
    assert.ok(
      codes(mutate((x) => (x.workflows[0].steps[1].inputs.who = { const: 'https://internal.example/api' }))).includes('HOST_ENDPOINT'),
    );
  });

  it('refuses expressions outside the closed language or reading undeclared names', () => {
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[0].method.rules[0].when = 'process.exit(1)'))).includes('BAD_EXPRESSION'));
    assert.ok(codes(mutate((x) => (x.workflows[0].steps[0].method.rules[0].when = 'secret_flag > 1'))).includes('EXPRESSION_SCOPE'));
  });

  it('requires requiresFeatures to cover what the workflow uses', () => {
    const d = mutate((x) => {
      x.workflows[0].steps[0].method = { kind: 'lookup', keys: ['amount'], rows: [{ amount: 1, tier: 'low' }], onMiss: 'escalate' };
    });
    assert.ok(codes(d).includes('FEATURES_UNDECLARED'));
  });

  it('refuses reading a possibly-skipped step unless the binding is optional', () => {
    const d = mutate((x) => {
      x.workflows[0].steps[0].runIf = 'amount > 0';
    });
    assert.ok(codes(d).includes('REF_MAYBE_SKIPPED'));
    const ok = mutate((x) => {
      x.workflows[0].steps[0].runIf = 'amount > 0';
      x.workflows[0].steps[1].inputs.tier = { from: 'steps.check.tier', optional: true };
    });
    assert.deepEqual(codes(ok), []);
  });

  it('refuses an unsupported semantics major version', () => {
    assert.ok(codes(mutate((x) => (x.semanticsVersion = '2.0'))).includes('SEMANTICS_UNSUPPORTED'));
  });

  it('refuses compensate steps wired into the normal graph', () => {
    const d = mutate((x) => {
      x.connectors[0].operations.push({ name: 'recall', sideEffect: 'write' });
      x.workflows[0].steps[1].compensatedBy = 'undo';
      x.workflows[0].steps.push({
        id: 'undo',
        type: 'compensate',
        determinism: 'deterministic',
        compensates: 'notify',
        connector: 'mail',
        operation: 'recall',
        sideEffect: 'write',
        idempotencyKey: 'undo:{{run.id}}',
        inputs: { who: { from: 'input.who' } },
        timeoutMs: 1000,
      });
      x.workflows[0].requiresFeatures = ['compensation', 'rules'];
    });
    assert.deepEqual(codes(d), []);
    d.workflows[0].steps[1].needs.push('undo');
    assert.ok(codes(d).includes('NEEDS_COMPENSATION_STEP'));
  });

  it('refuses oversized collections via the schema (bounded by construction)', () => {
    const d = mutate((x) => {
      x.workflows[0].steps = Array.from({ length: 257 }, (_, i) => ({ ...x.workflows[0].steps[0], id: `s${i}` }));
    });
    assert.ok(codes(d).includes('SCHEMA'));
  });

  it('the published schema file matches the generated schema', async () => {
    const { readFileSync } = await import('node:fs');
    const onDisk = JSON.parse(readFileSync(new URL('../schema/workflow-1.0.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(WORKFLOW_SCHEMA)));
  });

  it('typechecks as a WorkflowComponent', () => {
    const c: WorkflowComponent = base();
    assert.equal(c.workflows.length, 1);
  });
});
