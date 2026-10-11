import { describe, expect, it } from 'vitest';
import { XoClient, classifyStatus } from '../../src/platform/client';
import { fakeFetch } from '../fixtures';

const workspace = { workspaceId: 'ws_1', identityId: 'sally', name: 'Ops', createdAt: '2026-10-10T00:00:00Z', storageKeyPrefix: 'x/' };

describe('XoClient', () => {
  it('sends the bearer key on every call and parses a valid response', async () => {
    const f = fakeFetch({ 'GET /workspaces': () => ({ body: { workspaces: [workspace] } }) });
    const client = new XoClient({ apiKey: 'xoak_secret', fetch: f.fetch });
    const r = await client.listWorkspaces();
    expect(r).toEqual({ ok: true, value: [{ workspaceId: 'ws_1', name: 'Ops', createdAt: '2026-10-10T00:00:00Z' }] });
    expect(f.calls[0]?.headers['Authorization']).toBe('Bearer xoak_secret');
  });

  it.each([
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [400, 'rejected'],
    [422, 'rejected'],
    [501, 'unavailable'],
    [500, 'server'],
    [502, 'server'],
  ] as const)('classifies HTTP %i as %s and carries the platform code', async (status, kind) => {
    const f = fakeFetch({ 'GET /workspaces': () => ({ status, body: { error: { code: 'XO_SOMETHING', message: 'platform said no' } } }) });
    const r = await new XoClient({ apiKey: 'k', fetch: f.fetch }).listWorkspaces();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem.kind).toBe(kind);
      expect(r.problem.code).toBe('XO_SOMETHING');
      expect(r.problem.status).toBe(status);
    }
    expect(classifyStatus(status)).toBe(kind);
  });

  it('still classifies by status when the error body is unreadable', async () => {
    const f = fakeFetch({ 'GET /workspaces': () => ({ status: 401, raw: '<html>gateway</html>' }) });
    const r = await new XoClient({ apiKey: 'k', fetch: f.fetch }).listWorkspaces();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.kind).toBe('unauthenticated');
  });

  it('reports a network failure without a status', async () => {
    const f = fakeFetch({ 'GET /workspaces': () => 'network-error' });
    const r = await new XoClient({ apiKey: 'k', fetch: f.fetch }).listWorkspaces();
    expect(r).toMatchObject({ ok: false, problem: { kind: 'network' } });
  });

  it('treats a 200 with the wrong shape as malformed, not as data', async () => {
    const f = fakeFetch({ 'GET /workspaces': () => ({ body: { workspaces: [{ nope: true }] } }) });
    const r = await new XoClient({ apiKey: 'k', fetch: f.fetch }).listWorkspaces();
    expect(r).toMatchObject({ ok: false, problem: { kind: 'malformed' } });
  });

  it('treats a 200 with an unknown capability status as malformed (no invented states)', async () => {
    const bad = {
      capabilityId: 'c',
      contractId: 'c',
      name: 'n',
      description: 'd',
      status: 'validated',
      confidence: 1,
      provenance: [],
      approved: false,
    };
    const f = fakeFetch({ 'GET /workspaces/ws_1/compilations/cmp_1/capabilities': () => ({ body: { capabilities: [bad] } }) });
    const r = await new XoClient({ apiKey: 'k', fetch: f.fetch }).getCapabilities('ws_1', 'cmp_1');
    expect(r).toMatchObject({ ok: false, problem: { kind: 'malformed' } });
  });

  it('url-encodes path segments', async () => {
    const f = fakeFetch({ 'GET /workspaces/*': () => ({ body: { sources: [] } }) });
    await new XoClient({ apiKey: 'k', fetch: f.fetch }).listSources('ws/../x');
    expect(f.calls[0]?.url).toBe('/workspaces/ws%2F..%2Fx/sources');
  });

  it('never sends identity in the body: execution requests carry only compilation, capability and input', async () => {
    const f = fakeFetch({
      'POST /workspaces/ws_1/executions': () => ({ status: 403, body: { error: { code: 'XO_RUNTIME_PERMISSION_DENIED', message: 'no' } } }),
    });
    const r = await new XoClient({ apiKey: 'k', fetch: f.fetch }).createExecution('ws_1', 'cmp_1', 'cap_a', { claim: 1 });
    expect(f.calls[0]?.body).toEqual({ compilationId: 'cmp_1', capabilityId: 'cap_a', input: { claim: 1 } });
    expect(r).toMatchObject({ ok: false, problem: { kind: 'forbidden' } });
  });
});
