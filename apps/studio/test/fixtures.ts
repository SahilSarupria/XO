import type { Capability, Execution } from '../src/platform/wire';

export const cap = (over: Partial<Capability> = {}): Capability => ({
  capabilityId: 'cap_a',
  contractId: 'cap_a',
  name: 'Record before payment authorization',
  description: '9.5 The settlement amount must be recorded before payment authorization.',
  status: 'resolved',
  executionClass: 'deterministic_rule',
  confidence: 0.5,
  declaredConfidence: { score: 0.5, basis: 'self_reported' },
  provenance: [{ documentPath: 'src_x', pages: [2] }],
  approved: false,
  ...over,
});

export const exec = (over: Partial<Execution> = {}): Execution => ({
  executionId: 'exe_1',
  compilationId: 'cmp_1',
  capabilityId: 'cap_a',
  status: 'succeeded',
  requestedAt: '2026-10-10T10:00:00.000Z',
  input: {},
  ...over,
});

/** Builds a fake fetch from route handlers keyed "METHOD /path". Records every call. */
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
export function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body?: unknown; raw?: string } | 'network-error'>) {
  const calls: Call[] = [];
  const fn = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/^\/api/, '');
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep raw */
      }
    }
    const call: Call = { method, url: path, headers: (init?.headers ?? {}) as Record<string, string>, body };
    calls.push(call);
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && (p === path || (p?.endsWith('*') === true && path.startsWith(p.slice(0, -1))));
    });
    if (key === undefined)
      return new Response(JSON.stringify({ error: { code: 'XO_NOT_FOUND', message: `no route ${method} ${path}` } }), { status: 404 });
    const r = routes[key]!(call);
    if (r === 'network-error') throw new TypeError('Failed to fetch');
    return new Response(r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body)), { status: r.status ?? 200 });
  };
  return { fetch: fn, calls };
}
