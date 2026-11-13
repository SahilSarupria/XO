// UW-3: large files go through resumable uploads that survive a dropped connection and refuse to hide a real refusal.
import { describe, expect, it } from 'vitest';
import { RESUMABLE_UPLOAD_THRESHOLD_BYTES, XoClient } from '../../src/platform/client';

interface Server {
  readonly fetch: (input: string, init?: { method?: string; body?: unknown }) => Promise<Response>;
  readonly calls: string[];
  received: Uint8Array;
  declared?: string;
}

/** A minimal stand-in for the API's upload-session routes; `dropAfterApplying` loses the response of the n-th PUT after applying it. */
function server(opts: { dropAfterApplying?: number; failPuts?: number; refuseOpen?: boolean } = {}): Server {
  let puts = 0;
  let failures = opts.failPuts ?? 0;
  const s: Server = {
    calls: [],
    received: new Uint8Array(0),
    fetch: async (input, init) => {
      const url = new URL(input, 'http://x');
      const method = init?.method ?? 'GET';
      s.calls.push(`${method} ${url.pathname}${url.search}`);
      const session = () =>
        new Response(JSON.stringify({ uploadId: 'upl_1', offset: s.received.length, size: 9_000_000, maxChunkBytes: 8_388_608 }));
      if (method === 'POST' && url.pathname.endsWith('/uploads')) {
        if (opts.refuseOpen === true)
          return new Response(JSON.stringify({ error: { code: 'XO_INVALID_ARGUMENT', message: 'unsupported' } }), { status: 400 });
        s.declared = (JSON.parse(String(init?.body)) as { sha256: string }).sha256;
        return new Response(JSON.stringify({ uploadId: 'upl_1', offset: 0, size: 9_000_000, maxChunkBytes: 8_388_608 }), { status: 201 });
      }
      if (method === 'PUT') {
        if (failures > 0) {
          failures--;
          return new Response(JSON.stringify({ error: { code: 'XO_UNKNOWN', message: 'storage hiccup' } }), { status: 503 });
        }
        const offset = Number(url.searchParams.get('offset'));
        if (offset !== s.received.length)
          return new Response(JSON.stringify({ error: { code: 'XO_PRECONDITION_FAILED', message: 'offset' } }), { status: 412 });
        const chunk = init?.body as Uint8Array;
        const next = new Uint8Array(s.received.length + chunk.length);
        next.set(s.received);
        next.set(chunk, s.received.length);
        s.received = next;
        puts++;
        if (puts === opts.dropAfterApplying) throw new TypeError('network connection was lost');
        return session();
      }
      if (method === 'GET') return session();
      if (method === 'POST' && url.pathname.endsWith('/complete')) {
        return new Response(
          JSON.stringify({
            sourceId: 'src_1',
            originalFilename: 'scan.pdf',
            mediaType: 'application/pdf',
            byteSize: s.received.length,
            digestSha256: 'x',
            createdAt: '2026-11-13T00:00:00Z',
          }),
          { status: 201 },
        );
      }
      return new Response('{}', { status: 404 });
    },
  };
  return s;
}

const bigFile = () => {
  const bytes = new Uint8Array(9_000_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  return { file: new File([bytes], 'scan.pdf', { type: 'application/pdf' }), bytes };
};
const sha256 = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('resumable uploads', () => {
  it('a small file still goes in one request', async () => {
    const s = server();
    const client = new XoClient({ apiKey: 'k', fetch: s.fetch as never });
    await client.uploadSource('ws', new File([new Uint8Array(RESUMABLE_UPLOAD_THRESHOLD_BYTES)], 'a.csv'));
    expect(s.calls).toEqual(['POST /api/workspaces/ws/sources?filename=a.csv']);
  });

  it('a large file is chunked, declares its SHA-256, survives a lost response, and arrives byte for byte', async () => {
    const s = server({ dropAfterApplying: 2 });
    const progress: number[] = [];
    const client = new XoClient({ apiKey: 'k', fetch: s.fetch as never, sleep: async () => undefined });
    const { file, bytes } = bigFile();
    const r = await client.uploadSource('ws', file, (sent) => progress.push(sent));
    expect(r.ok).toBe(true);
    expect(await sha256(s.received)).toBe(await sha256(bytes));
    expect(s.declared).toBe(await sha256(bytes));
    expect(s.calls).toContain('GET /api/workspaces/ws/uploads/upl_1'); // asked where the server got to after the lost response
    expect(progress.at(-1)).toBe(bytes.length);
    expect(s.calls.at(-1)).toBe('POST /api/workspaces/ws/uploads/upl_1/complete');
  });

  it('transient server errors are retried with back-off; a refusal is returned at once', async () => {
    const waits: number[] = [];
    const s = server({ failPuts: 2 });
    const client = new XoClient({ apiKey: 'k', fetch: s.fetch as never, sleep: async (ms) => void waits.push(ms) });
    const { file, bytes } = bigFile();
    expect((await client.uploadSource('ws', file)).ok).toBe(true);
    expect(await sha256(s.received)).toBe(await sha256(bytes));
    expect(waits).toEqual([500, 1000]);

    const refused = await new XoClient({ apiKey: 'k', fetch: server({ refuseOpen: true }).fetch as never }).uploadSource(
      'ws',
      bigFile().file,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problem.kind).toBe('rejected');
  });

  it('gives up after repeated failures and says so, leaving the session resumable', async () => {
    const s = server({ failPuts: 100 });
    const client = new XoClient({ apiKey: 'k', fetch: s.fetch as never, sleep: async () => undefined });
    const r = await client.uploadSource('ws', bigFile().file);
    expect(r.ok).toBe(false);
    expect(s.calls.filter((c) => c.startsWith('PUT')).length).toBe(6);
  });
});
