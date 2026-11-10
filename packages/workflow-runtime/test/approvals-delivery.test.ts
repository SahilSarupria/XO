import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  ApprovalDeliveryError,
  StaticReviewerRegistry,
  combineSinks,
  generateReviewerKeys,
  parseReviewers,
  webhookApprovalSink,
  type ApprovalRequest,
} from '../src/index.js';
import { comp, decide, harness, pay } from './support.js';

const SECRET = 'a-long-enough-shared-secret';
const req = { approvalId: 'appr_x', runId: 'r', step: 'gate' } as unknown as ApprovalRequest;
const res = (status: number): Response => new Response('', { status });

describe('approval webhook delivery', () => {
  it('posts a signed body with a delivery id, retries 5xx with backoff, and stops at the first success', async () => {
    const calls: { body: string; headers: Record<string, string> }[] = [];
    const answers = [503, 500, 200];
    const sleeps: number[] = [];
    const sink = webhookApprovalSink('https://hooks.example/approvals', SECRET, {
      sleep: async (ms) => void sleeps.push(ms),
      fetchImpl: (async (_u: string, init: RequestInit) => {
        calls.push({ body: String(init.body), headers: init.headers as Record<string, string> });
        return res(answers.shift() ?? 200);
      }) as unknown as typeof fetch,
    });
    await sink(req);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [250, 500]);
    const c = calls[0]!;
    assert.equal(c.headers['x-xo-delivery'], 'appr_x');
    assert.equal(c.headers['x-xo-approval-signature'], `sha256=${createHmac('sha256', SECRET).update(c.body).digest('hex')}`);
    assert.equal((JSON.parse(c.body) as { event: string }).event, 'approval.requested');
  });
  it('does not retry a request the endpoint rejects as wrong (4xx), but does retry 429; gives up with a typed error', async () => {
    let n = 0;
    const mk = (status: number) =>
      webhookApprovalSink('https://h.example/x', SECRET, {
        sleep: async () => undefined,
        fetchImpl: (async () => (n++, res(status))) as unknown as typeof fetch,
      });
    await assert.rejects(mk(403)(req), ApprovalDeliveryError);
    assert.equal(n, 1);
    n = 0;
    await assert.rejects(mk(429)(req), /answered 429/);
    assert.equal(n, 3);
    const down = webhookApprovalSink('https://h.example/x', SECRET, {
      sleep: async () => undefined,
      fetchImpl: (async () => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch,
    });
    await assert.rejects(down(req), /ECONNRESET/);
  });
  it('adversarial configuration: http to a remote host, credentials in the URL, short secrets and junk URLs are refused up front', () => {
    for (const [u, s] of [
      ['http://evil.example/x', SECRET],
      ['https://u:p@h.example/x', SECRET],
      ['https://h.example/x', 'short'],
      ['not a url', SECRET],
      ['ftp://h.example', SECRET],
    ] as const)
      assert.throws(() => webhookApprovalSink(u, s), undefined, u);
    assert.doesNotThrow(() => webhookApprovalSink('http://127.0.0.1:9/x', SECRET));
  });
  it('redirects are refused (the signed body must not follow a redirect to another host)', async () => {
    let init: RequestInit | undefined;
    await webhookApprovalSink('https://h.example/x', SECRET, {
      fetchImpl: (async (_u: string, i: RequestInit) => ((init = i), res(200))) as unknown as typeof fetch,
    })(req);
    assert.equal(init?.redirect, 'error');
  });
  it('combineSinks attempts every sink even when one fails, then reports the failure', async () => {
    const seen: string[] = [];
    const sink = combineSinks(
      async () => void seen.push('a'),
      async () => Promise.reject(new Error('b broke')),
      async () => void seen.push('c'),
    );
    await assert.rejects(sink(req), /b broke/);
    assert.deepEqual(seen, ['a', 'c']);
  });
});

describe('reviewer trust-policy loader', () => {
  const k = generateReviewerKeys().publicKeyPem;
  const ok = { id: 'ann', roles: ['reviewer'], publicKeyPem: k };
  it('accepts a list or {reviewers}, de-duplicates roles and keeps revocations', () => {
    assert.equal(parseReviewers([ok]).length, 1);
    const r = parseReviewers({ reviewers: [{ ...ok, roles: ['reviewer', 'reviewer'], revoked: true }] });
    assert.deepEqual([r[0]?.roles, r[0]?.revoked], [['reviewer'], true]);
    assert.equal(new StaticReviewerRegistry(r).get('ann')?.revoked, true);
  });
  it('adversarial: every malformed entry is an error naming the entry, never a skipped or defaulted reviewer', () => {
    const bad: [unknown, RegExp][] = [
      [[], /no reviewers/],
      [{}, /must be a list/],
      ['x', /must be a list/],
      [[ok, ok], /duplicate reviewer id/],
      [[{ ...ok, extra: 1 }], /unknown field/],
      [[{ ...ok, id: '../x' }], /id must be/],
      [[{ ...ok, roles: [] }], /roles must be/],
      [[{ ...ok, roles: ['admin'] }], /roles must be/],
      [[{ ...ok, publicKeyPem: 'nope' }], /not an Ed25519 public key/],
      [[{ ...ok, publicKeyPem: undefined }], /publicKeyPem is required/],
      [[{ ...ok, revoked: 'yes' }], /revoked must be true or false/],
      [[null], /must be an object/],
    ];
    for (const [input, re] of bad) assert.throws(() => parseReviewers(input), re, JSON.stringify(input)?.slice(0, 60));
  });
  it('rejects a non-Ed25519 key (an RSA key must not be accepted as a reviewer identity)', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    assert.throws(() => parseReviewers([{ ...ok, publicKeyPem: rsa }]), /Ed25519/);
  });
});

describe('runner: delivery failure never loses or resolves an approval', () => {
  const gate = (): any => ({
    id: 'gate',
    type: 'approve',
    determinism: 'human',
    needs: ['check'],
    timeoutMs: 60_000,
    roles: ['reviewer'],
    onTimeout: 'escalate',
    onError: 'escalate',
    summary: 'Pay {{input.claim}}?',
    inputs: { amount: { from: 'input.amount' } },
    outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'] } },
  });
  it('journals ok/failed delivery; the approval stays pending and listable either way', async () => {
    const h = await harness(
      comp([
        decide(),
        gate(),
        pay({
          needs: ['gate'],
          runIf: "decision == 'approved'",
          inputs: { decision: { from: 'steps.gate.decision' }, amount: { from: 'input.amount' } },
        }),
      ]),
    );
    const reviewers = new StaticReviewerRegistry(
      parseReviewers([{ id: 'ann', roles: ['reviewer'], publicKeyPem: generateReviewerKeys().publicKeyPem }]),
    );
    for (const fail of [false, true]) {
      const { runner, store } = h.mk({
        approvals: { reviewers, sink: async () => (fail ? Promise.reject(new Error('endpoint down')) : undefined) },
      });
      const r = await runner.start({ inputs: { amount: 10, claim: fail ? 'bad' : 'good' } });
      assert.equal(r.state, 'waiting');
      const entry = (await store.read(r.runId)).find((e) => e.type === 'approval_delivery');
      assert.equal((entry?.data as { ok: boolean }).ok, !fail);
      if (fail) assert.match(String((entry?.data as { error: string }).error), /endpoint down/);
      assert.equal(
        (await runner.listApprovals()).some((a) => a.runId === r.runId),
        true,
      );
      assert.equal(h.ext.effects.length, 0); // nothing was sent: a lost notification is not an approval
    }
  });
});
