import type { ApiResult, XoApi } from '../src/api-client.js';

export interface Recorded {
  readonly op: 'list' | 'get' | 'start';
  readonly args: readonly unknown[];
}

const SCHEMA = {
  type: 'object',
  properties: { amount: { type: 'number' }, note: { type: 'string' } },
  required: ['amount'],
  additionalProperties: false,
};

export const approvedDetail = (procedureId = 'pay', version = 1, over: Record<string, unknown> = {}): unknown => ({
  procedureId,
  version,
  lifecycle: 'approved',
  definition: { title: 'Pay invoice' },
  inputSchema: SCHEMA,
  ...over,
});

/** Scriptable stand-in for the XO API. It records every call so tests can prove what was (not) sent. */
export class FakeApi implements XoApi {
  readonly calls: Recorded[] = [];
  list: ApiResult = {
    kind: 'ok',
    status: 200,
    body: { procedures: [{ procedureId: 'pay', versions: [{ version: 1, lifecycle: 'approved' }] }] },
  };
  get: (id: string, v: number) => ApiResult = (id, v) => ({ kind: 'ok', status: 200, body: approvedDetail(id, v) });
  start: (input: Readonly<Record<string, unknown>>, key: string, signal: AbortSignal) => Promise<ApiResult> | ApiResult = () => ({
    kind: 'ok',
    status: 201,
    body: {
      procedureExecutionId: 'pex_1',
      status: 'completed',
      steps: [{ stepId: 's', status: 'succeeded' }],
      outputs: { s: { ok: true } },
    },
  });

  listProcedures(_signal: AbortSignal): Promise<ApiResult> {
    this.calls.push({ op: 'list', args: [] });
    return Promise.resolve(this.list);
  }
  getProcedure(id: string, version: number, _signal: AbortSignal): Promise<ApiResult> {
    this.calls.push({ op: 'get', args: [id, version] });
    return Promise.resolve(this.get(id, version));
  }
  async startProcedure(
    id: string,
    version: number,
    input: Readonly<Record<string, unknown>>,
    key: string,
    signal: AbortSignal,
  ): Promise<ApiResult> {
    this.calls.push({ op: 'start', args: [id, version, input, key] });
    return this.start(input, key, signal);
  }
  starts(): readonly Recorded[] {
    return this.calls.filter((c) => c.op === 'start');
  }
}
