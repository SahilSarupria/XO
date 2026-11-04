import { CONNECTOR_KINDS, WORKFLOW_FEATURES } from './types.js';

/**
 * The published structural schema for a `workflows/workflows.json` component
 * (JSON Schema draft 2020-12 subset). `additionalProperties: false` everywhere:
 * a field this schema does not name is a refusal, not an extension point. Hosts
 * that want vendor extensions must wait for a semantics bump (fail closed).
 *
 * Cross-field rules (graph acyclicity, reference resolution, idempotency keys,
 * determinism classes ...) cannot be expressed in JSON Schema; they are enforced
 * by `validateWorkflowComponent` and specified in docs/WORKFLOW_IR.md.
 */

type S = Record<string, unknown>;

const ID = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' };
const ID_REF = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' };
const SEMVER = { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' };
const SCALAR = { type: ['string', 'number', 'boolean', 'null'] };
const EXPR = { type: 'string', minLength: 1, maxLength: 2000 };
const TEXT = (max: number): S => ({ type: 'string', minLength: 1, maxLength: max });
const INT = (min: number, max: number): S => ({ type: 'integer', minimum: min, maximum: max });
const obj = (properties: S, required: string[]): S => ({ type: 'object', properties, required, additionalProperties: false });
const str = (v: string): S => ({ const: v });
const REC = (value: S): S => ({ type: 'object', additionalProperties: value, maxProperties: 256 });

const FIELD: S = obj(
  {
    type: { enum: ['string', 'number', 'integer', 'boolean', 'enum', 'json'] },
    enum: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 }, minItems: 1, maxItems: 256 },
    description: TEXT(500),
    maxBytes: INT(1, 1_048_576),
    nullable: { type: 'boolean' },
  },
  ['type'],
);
const INPUT: S = obj({ ...(FIELD['properties'] as S), required: { type: 'boolean' } }, ['type']);

const BINDING: S = {
  oneOf: [
    obj(
      { from: { type: 'string', pattern: '^(input|run|item|steps)(\\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,2}$' }, optional: { type: 'boolean' } },
      ['from'],
    ),
    obj({ const: SCALAR }, ['const']),
  ],
};

const RETRY: S = obj(
  {
    maxAttempts: INT(1, 10),
    backoff: obj(
      {
        kind: { enum: ['fixed', 'exponential'] },
        baseMs: INT(1, 3_600_000),
        maxMs: INT(1, 86_400_000),
        jitter: { enum: ['none', 'full'] },
      },
      ['kind', 'baseMs', 'maxMs', 'jitter'],
    ),
  },
  ['maxAttempts', 'backoff'],
);

const COMMON: S = {
  id: ID,
  determinism: { enum: ['deterministic', 'model_assisted', 'human'] },
  needs: { type: 'array', items: ID_REF, maxItems: 64, uniqueItems: true },
  runIf: EXPR,
  inputs: REC(BINDING),
  outputs: REC(FIELD),
  timeoutMs: INT(1, 604_800_000),
  retry: RETRY,
  onError: { enum: ['fail', 'escalate', 'compensate'] },
  idempotencyKey: TEXT(500),
  description: TEXT(500),
  provenance: { type: 'array', items: TEXT(300), maxItems: 64 },
};
const COMMON_REQUIRED = ['id', 'type', 'determinism', 'timeoutMs'];
const step = (type: string, extra: S, required: string[]): S =>
  obj({ type: str(type), ...COMMON, ...extra }, [...COMMON_REQUIRED, ...required]);

const SETMAP: S = { type: 'object', additionalProperties: SCALAR, minProperties: 1, maxProperties: 64 };

const DECIDE_METHOD: S = {
  oneOf: [
    obj({ kind: str('tree'), treeId: TEXT(128) }, ['kind', 'treeId']),
    obj(
      {
        kind: str('rules'),
        rules: { type: 'array', minItems: 1, maxItems: 512, items: obj({ id: ID, when: EXPR, set: SETMAP }, ['id', 'when', 'set']) },
        onNoMatch: { enum: ['escalate', 'default'] },
        default: SETMAP,
      },
      ['kind', 'rules', 'onNoMatch'],
    ),
    obj({ kind: str('formula'), set: { type: 'object', additionalProperties: EXPR, minProperties: 1, maxProperties: 64 } }, [
      'kind',
      'set',
    ]),
    obj(
      {
        kind: str('lookup'),
        keys: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, minItems: 1, maxItems: 8 },
        rows: { type: 'array', minItems: 1, maxItems: 10_000, items: { type: 'object', additionalProperties: SCALAR, maxProperties: 64 } },
        onMiss: str('escalate'),
      },
      ['kind', 'keys', 'rows', 'onMiss'],
    ),
  ],
};

const WAIT_FOR: S = {
  oneOf: [
    obj({ kind: str('timer'), delayMs: INT(1, 604_800_000) }, ['kind', 'delayMs']),
    obj({ kind: str('event'), name: TEXT(128), correlationKey: ID_REF }, ['kind', 'name', 'correlationKey']),
    obj({ kind: str('approval'), step: ID_REF }, ['kind', 'step']),
  ],
};

const STEP: S = {
  oneOf: [
    step(
      'extract',
      {
        instruction: TEXT(4000),
        requires: { type: 'array', items: { enum: ['structured_output', 'long_context'] }, maxItems: 2, uniqueItems: true },
        structuredFirst: { type: 'boolean' },
        grounding: { enum: ['none', 'quote_required'] },
        maxModelCalls: INT(1, 10),
      },
      ['instruction'],
    ),
    step('decide', { method: DECIDE_METHOD }, ['method']),
    step('act', { connector: ID_REF, operation: ID_REF, sideEffect: { enum: ['read', 'write', 'irreversible'] }, compensatedBy: ID_REF }, [
      'connector',
      'operation',
      'sideEffect',
    ]),
    step(
      'approve',
      {
        roles: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { enum: ['publisher', 'reviewer', 'installer', 'auditor'] },
        },
        summary: TEXT(2000),
        evidence: { type: 'array', items: ID_REF, maxItems: 64, uniqueItems: true },
        onTimeout: str('escalate'),
        allowEdit: { type: 'boolean' },
      },
      ['roles', 'summary', 'onTimeout'],
    ),
    step(
      'branch',
      {
        cases: { type: 'array', minItems: 1, maxItems: 64, items: obj({ route: ID_REF, when: EXPR }, ['route', 'when']) },
        default: ID_REF,
      },
      ['cases', 'default'],
    ),
    step('wait', { for: WAIT_FOR, onTimeout: { enum: ['escalate', 'fail'] } }, ['for', 'onTimeout']),
    step('compensate', { compensates: ID_REF, connector: ID_REF, operation: ID_REF, sideEffect: { enum: ['write', 'irreversible'] } }, [
      'compensates',
      'connector',
      'operation',
      'sideEffect',
    ]),
    step('escalate', { target: TEXT(128), reason: TEXT(1000), lane: TEXT(128) }, ['target', 'reason']),
  ],
};

const MAP: S = {
  type: 'object',
  additionalProperties: { type: 'string', pattern: '^(/[^/~]*(~[01][^/~]*)*)+$', maxLength: 256 },
  maxProperties: 64,
};
const trig = (kind: string, extra: S, required: string[]): S =>
  obj({ id: ID, kind: str(kind), ...extra, map: MAP }, ['id', 'kind', ...required]);
const LOGICAL = { type: 'string', pattern: '^[a-z][a-z0-9_.-]{0,63}$' };

const TRIGGER: S = {
  oneOf: [
    trig(
      'webhook',
      {
        route: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}(/[a-z0-9][a-z0-9_-]{0,63}){0,3}$' },
        auth: { enum: ['token', 'hmac'] },
      },
      ['route', 'auth'],
    ),
    trig(
      'cron',
      { schedule: { type: 'string', minLength: 9, maxLength: 100 }, timezone: { type: 'string', minLength: 1, maxLength: 64 } },
      ['schedule', 'timezone'],
    ),
    trig('directory', { source: LOGICAL, pattern: { type: 'string', minLength: 1, maxLength: 128 } }, ['source', 'pattern']),
    trig('batch_file', { source: LOGICAL, format: { enum: ['csv', 'jsonl'] }, maxRows: INT(1, 10_000_000) }, [
      'source',
      'format',
      'maxRows',
    ]),
    trig('mcp_event', { server: LOGICAL, event: TEXT(128) }, ['server', 'event']),
    trig('api', {}, []),
  ],
};

const WORKFLOW: S = obj(
  {
    id: ID,
    version: SEMVER,
    description: TEXT(1000),
    triggers: { type: 'array', items: TRIGGER, minItems: 1, maxItems: 16 },
    inputs: REC(INPUT),
    steps: { type: 'array', items: STEP, minItems: 1, maxItems: 256 },
    forEach: obj(
      { over: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' }, maxItems: INT(1, 100_000), concurrency: INT(1, 256) },
      ['over', 'maxItems', 'concurrency'],
    ),
    result: REC(BINDING),
    maxConcurrency: INT(1, 256),
    runTimeoutMs: INT(1, 2_592_000_000),
    cancellation: obj({ onCancel: { enum: ['compensate', 'abandon'] } }, ['onCancel']),
    authority: obj(
      {
        ceilings: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: obj({ value: BINDING, max: { type: 'number' }, onExceed: str('escalate') }, ['value', 'max', 'onExceed']),
        },
      },
      ['ceilings'],
    ),
    requiresFeatures: { type: 'array', items: { enum: [...WORKFLOW_FEATURES] }, uniqueItems: true, maxItems: 16 },
  },
  ['id', 'version', 'triggers', 'inputs', 'steps', 'maxConcurrency', 'runTimeoutMs', 'cancellation'],
);

const CONNECTOR: S = obj(
  {
    id: ID,
    kind: { enum: [...CONNECTOR_KINDS] },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: 128,
      items: obj(
        {
          name: ID,
          sideEffect: { enum: ['read', 'write', 'irreversible'] },
          secrets: { type: 'array', items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' }, maxItems: 16, uniqueItems: true },
        },
        ['name', 'sideEffect'],
      ),
    },
  },
  ['id', 'kind', 'operations'],
);

export const WORKFLOW_SCHEMA: S = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://xo.dev/schemas/workflow-1.0.schema.json',
  title: 'XO Workflow component 1.0',
  ...obj(
    {
      formatVersion: str('1.0'),
      semanticsVersion: { type: 'string', pattern: '^\\d+\\.\\d+$' },
      connectors: { type: 'array', items: CONNECTOR, maxItems: 64 },
      workflows: { type: 'array', items: WORKFLOW, minItems: 1, maxItems: 64 },
    },
    ['formatVersion', 'semanticsVersion', 'connectors', 'workflows'],
  ),
};
