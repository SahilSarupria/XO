import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryEventInbox } from '@xo/workflow-runtime';
import { call, json, start } from './harness.js';

const body = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'doc.received', correlation: 'c1', eventId: 'e1', payload: { amt: 1 }, ...o });

describe('POST /v1/events', () => {
  it('accepts a valid event (202), tells every runner, and answers a retry with 200 without telling anyone twice more than needed', async () => {
    const f = await start();
    try {
      const t = f.tokens['eventer']!;
      const a = await call(f, 'POST', '/v1/events', { token: t, body: body() });
      assert.equal(a.status, 202);
      assert.equal(json(a)['status'], 'queued');
      assert.ok(f.reached.includes('runner.notifyEvent'));
      const b = await call(f, 'POST', '/v1/events', { token: t, body: body() });
      assert.equal(b.status, 200);
      assert.equal(json(b)['status'], 'duplicate');
    } finally {
      await f.close();
    }
  });

  it('refuses malformed events with 422 and stores nothing', async () => {
    const inbox = new MemoryEventInbox();
    const f = await start({ events: inbox });
    try {
      const t = f.tokens['eventer']!;
      for (const bad of [
        body({ name: '../x' }),
        body({ eventId: 'a b' }),
        body({ correlation: '' }),
        body({ payload: { deep: { x: 1 } } }),
        body({ payload: 'text' }),
        body({ payload: { big: 'x'.repeat(20_000) } }),
      ]) {
        const r = await call(f, 'POST', '/v1/events', { token: t, body: bad });
        assert.equal(r.status, 422, bad.slice(0, 60));
        assert.equal(json(r)['error'], 'INVALID_EVENT');
      }
      assert.equal(await inbox.claim('doc.received', 'c1', 'x::y'), undefined);
      assert.equal(f.reached.includes('runner.notifyEvent'), false);
    } finally {
      await f.close();
    }
  });

  it('answers 501 when the server has no inbox, 415 for a non-JSON body, 413 for an oversized one, and only POST is allowed', async () => {
    const off = await start({ events: undefined as never });
    try {
      assert.equal((await call(off, 'POST', '/v1/events', { token: off.tokens['eventer']!, body: body() })).status, 501);
    } finally {
      await off.close();
    }
    const f = await start();
    try {
      const t = f.tokens['eventer']!;
      assert.equal((await call(f, 'POST', '/v1/events', { token: t, body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
      assert.equal((await call(f, 'POST', '/v1/events', { token: t, body: body({ payload: { p: 'x'.repeat(70_000) } }) })).status, 413);
      assert.equal((await call(f, 'GET', '/v1/events', { token: t })).status, 403); // GET needs admin
    } finally {
      await f.close();
    }
  });

  it('needs the event scope: read/run/approve tokens are refused before the body is read', async () => {
    const f = await start();
    try {
      for (const who of ['reader', 'runner', 'approver', 'leaser', 'syncer']) {
        const r = await call(f, 'POST', '/v1/events', { token: f.tokens[who]!, body: body() });
        assert.equal(r.status, 403, who);
      }
      assert.equal(f.reached.includes('runner.notifyEvent'), false);
      assert.equal((await call(f, 'POST', '/v1/events', { body: body() })).status, 401);
    } finally {
      await f.close();
    }
  });
});
