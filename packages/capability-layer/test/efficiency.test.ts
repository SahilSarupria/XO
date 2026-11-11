import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import {
  assembleContext,
  coalescingProvider,
  estimateTokens,
  LayerCache,
  LOW_RESOURCE,
  PromptBudgetError,
  runAgent,
  type CapabilityLayer,
} from '../src/index.js';

/** Mechanism tests only. Nothing here measures savings on real traffic or a live model. */

const resp = (text: string): ProviderResponse =>
  ({ text, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }) as ProviderResponse;
const req = (content: string, temperature?: number): ProviderRequest =>
  ({
    model: 'm',
    messages: [{ role: 'user', content }],
    maxOutputTokens: 10,
    ...(temperature !== undefined ? { temperature } : {}),
  }) as ProviderRequest;

function gated(): { provider: ModelProvider; release: (n?: number) => void; calls: () => number; fail: (e: Error) => void } {
  let calls = 0;
  const waiting: { ok: () => void; bad: (e: Error) => void }[] = [];
  const provider = {
    id: 'p',
    describeCapabilities: () => ({}) as never,
    complete: (r: ProviderRequest) => {
      calls++;
      return new Promise<ProviderResponse>((ok, bad) => waiting.push({ ok: () => ok(resp(`answer:${JSON.stringify(r.messages)}`)), bad }));
    },
  } as ModelProvider;
  return {
    provider,
    calls: () => calls,
    release: (n = waiting.length) => waiting.splice(0, n).forEach((w) => w.ok()),
    fail: (e) => waiting.splice(0).forEach((w) => w.bad(e)),
  };
}

describe('coalescingProvider', () => {
  it('shares one call between identical in-flight deterministic requests, then does not cache', async () => {
    const g = gated();
    const c = coalescingProvider(g.provider);
    const a = c.complete(req('x', 0));
    const b = c.complete(req('x', 0));
    assert.equal(g.calls(), 1);
    g.release();
    assert.equal((await a).text, (await b).text);
    assert.deepEqual({ ...c.stats }, { calls: 1, coalesced: 1 });
    const again = c.complete(req('x', 0)); // settled: no stale reuse
    assert.equal(g.calls(), 2);
    g.release();
    await again;
  });

  it('does not merge different requests, or sampled ones by default', async () => {
    const g = gated();
    const c = coalescingProvider(g.provider);
    void c.complete(req('x', 0));
    void c.complete(req('y', 0));
    void c.complete(req('x', 0.7));
    void c.complete(req('x', 0.7));
    void c.complete(req('x'));
    assert.equal(g.calls(), 5);
    g.release();
    const all = coalescingProvider(gated().provider, { mode: 'all' });
    void all.complete(req('x', 0.7));
    void all.complete(req('x', 0.7));
    assert.equal(all.stats.calls, 1);
  });

  it('key order of the request does not matter, content does', async () => {
    const g = gated();
    const c = coalescingProvider(g.provider);
    const r1 = { model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0 } as ProviderRequest;
    const r2 = { temperature: 0, messages: [{ content: 'x', role: 'user' }], model: 'm' } as ProviderRequest;
    void c.complete(r1);
    void c.complete(r2);
    assert.equal(g.calls(), 1);
  });

  it('shares a failure with its waiters, and the next request starts fresh', async () => {
    const g = gated();
    const c = coalescingProvider(g.provider);
    const a = c.complete(req('x', 0));
    const b = c.complete(req('x', 0));
    g.fail(new Error('boom'));
    await assert.rejects(a, /boom/);
    await assert.rejects(b, /boom/);
    const next = c.complete(req('x', 0));
    assert.equal(g.calls(), 2);
    g.release();
    await next;
  });

  it("adversarial: a caller cannot receive another request's answer (distinct content stays distinct)", async () => {
    const g = gated();
    const c = coalescingProvider(g.provider);
    const secretA = c.complete(req('tenant A: account 111', 0));
    const secretB = c.complete(req('tenant B: account 222', 0));
    g.release();
    assert.match((await secretA).text, /111/);
    assert.doesNotMatch((await secretA).text, /222/);
    assert.match((await secretB).text, /222/);
  });

  it('caps waiters on one call', async () => {
    const g = gated();
    const c = coalescingProvider(g.provider, { maxWaiters: 2 });
    for (let i = 0; i < 3; i++) void c.complete(req('x', 0));
    assert.equal(g.calls(), 2);
  });
});

describe('LayerCache', () => {
  const host = { family: 'generic', capabilities: ['chat'] } as never;
  it('reuses the layer for the same bundle object and options; separates others', () => {
    let built = 0;
    const cache = new LayerCache(8, () => ({ n: ++built }) as unknown as CapabilityLayer);
    const b1 = {} as never;
    const b2 = {} as never;
    const l1 = cache.get(b1, { host });
    assert.equal(cache.get(b1, { host }), l1);
    assert.notEqual(cache.get(b2, { host }), l1);
    assert.notEqual(cache.get(b1, { host, requireEvidence: true }), l1);
    assert.notEqual(cache.get(b1, { host, integrity: 'development' as never }), l1);
    assert.equal(cache.hits, 1);
    assert.equal(built, 4);
  });

  it("adversarial: a different trust policy is never served another policy's layer", () => {
    const cache = new LayerCache(8, () => ({}) as CapabilityLayer);
    const b = {} as never;
    const strict = cache.get(b, { host, trust: { mode: 'enforce' } as never });
    const lax = cache.get(b, { host });
    assert.notEqual(strict, lax);
  });

  it('does not cache a failed load, and bypasses the cache for function-valued options', () => {
    let n = 0;
    const cache = new LayerCache(8, () => {
      if (++n === 1) throw new Error('tampered');
      return {} as CapabilityLayer;
    });
    const b = {} as never;
    assert.throws(() => cache.get(b, { host }), /tampered/);
    const ok = cache.get(b, { host });
    assert.equal(cache.get(b, { host }), ok);
    const dated = cache.get(b, { host, now: () => new Date(0) });
    assert.notEqual(cache.get(b, { host, now: () => new Date(0) }), dated);
  });

  it('is bounded: the oldest entry is evicted', () => {
    let n = 0;
    const cache = new LayerCache(2, () => ({ n: ++n }) as unknown as CapabilityLayer);
    const bs = [{}, {}, {}].map((x) => x as never);
    const first = cache.get(bs[0] as never, { host });
    cache.get(bs[1] as never, { host });
    cache.get(bs[2] as never, { host });
    assert.notEqual(cache.get(bs[0] as never, { host }), first);
    assert.throws(() => new LayerCache(0), /positive/);
  });
});

function fakeLayer(opts: {
  fragments: string[];
  nodes: { id: string; text: string }[];
  ex: { id: string; text: string }[];
}): CapabilityLayer {
  return {
    systemPromptFragments: () => opts.fragments,
    retrieve: (_q: string, k: number) => opts.nodes.slice(0, k),
    exemplars: (_t: string | undefined, k: number) => opts.ex.slice(0, k),
    toolDefinitions: () => [],
  } as unknown as CapabilityLayer;
}

describe('assembleContext budget', () => {
  const layer = fakeLayer({
    fragments: ['SAFETY: never auto-approve'],
    nodes: [
      { id: 'k1', text: 'a'.repeat(400) },
      { id: 'k2', text: 'b'.repeat(400) },
      { id: 'k3', text: 'c'.repeat(400) },
    ],
    ex: [{ id: 'e1', text: 'x'.repeat(400) }],
  });

  it('without a budget the output is unchanged and has no accounting', () => {
    const c = assembleContext(layer, { query: 'q', preamble: 'P' });
    assert.equal(c.injected.budget, undefined);
    assert.deepEqual(c.injected.knowledgeNodeIds, ['k1', 'k2', 'k3']);
    assert.deepEqual(c.injected.exemplarIds, ['e1']);
  });

  it('drops examples first, then the lowest-ranked knowledge, and reports it', () => {
    const full = estimateTokens(assembleContext(layer, { query: 'q' }).systemPrompt);
    const noEx = assembleContext(layer, { query: 'q', maxPromptTokens: full - 1 });
    assert.deepEqual(noEx.injected.exemplarIds, []);
    assert.deepEqual(noEx.injected.knowledgeNodeIds, ['k1', 'k2', 'k3']);
    assert.deepEqual(noEx.injected.budget?.droppedExemplarIds, ['e1']);
    const tight = assembleContext(layer, { query: 'q', maxPromptTokens: 300 });
    assert.deepEqual(tight.injected.knowledgeNodeIds, ['k1', 'k2']);
    assert.deepEqual(tight.injected.budget?.droppedKnowledgeNodeIds, ['k3']);
    assert.ok((tight.injected.budget?.promptTokens ?? 999) <= 300);
  });

  it('adversarial: safety text and preamble are never trimmed; too small a budget throws', () => {
    const c = assembleContext(layer, { query: 'q', preamble: 'P', maxPromptTokens: 12 });
    assert.match(c.systemPrompt, /SAFETY: never auto-approve/);
    assert.deepEqual(c.injected.knowledgeNodeIds, []);
    assert.throws(() => assembleContext(layer, { query: 'q', preamble: 'P', maxPromptTokens: 3 }), PromptBudgetError);
    assert.throws(() => assembleContext(layer, { query: 'q', maxPromptTokens: Number.NaN }), PromptBudgetError);
    assert.throws(() => assembleContext(layer, { query: 'q', maxPromptTokens: -1 }), PromptBudgetError);
  });

  it('uses an injected counter', () => {
    const c = assembleContext(layer, { query: 'q', maxPromptTokens: 2, countTokens: (t) => (t.includes('<xo_') ? 5 : 1) });
    assert.deepEqual(c.injected.knowledgeNodeIds, []);
  });
});

describe('runAgent wall-clock cap', () => {
  const base = { model: 'm', systemPrompt: 's' };
  it('stops a provider call that outlives the cap and ignores its late result', async () => {
    let finish: (r: ProviderResponse) => void = () => undefined;
    const provider = {
      id: 'p',
      describeCapabilities: () => ({}) as never,
      complete: () => new Promise<ProviderResponse>((ok) => (finish = ok)),
    } as ModelProvider;
    const run = await runAgent(provider, 'q', { ...base, maxWallClockMs: 20 });
    assert.equal(run.stoppedBy, 'wall_clock');
    assert.equal(run.truncated, true);
    finish(resp('late'));
    assert.equal(run.text, '');
  });

  it('a late failure of the abandoned call does not become an unhandled rejection', async () => {
    let fail: (e: Error) => void = () => undefined;
    const provider = {
      id: 'p',
      describeCapabilities: () => ({}) as never,
      complete: () => new Promise<ProviderResponse>((_ok, bad) => (fail = bad)),
    } as ModelProvider;
    let unhandled = false;
    const h = (): void => {
      unhandled = true;
    };
    process.on('unhandledRejection', h);
    await runAgent(provider, 'q', { ...base, maxWallClockMs: 10 });
    fail(new Error('late'));
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', h);
    assert.equal(unhandled, false);
  });

  it('is checked before each call and during a slow tool', async () => {
    let t = 0;
    let calls = 0;
    const provider = {
      id: 'p',
      describeCapabilities: () => ({}) as never,
      complete: async () => {
        calls++;
        return {
          text: '',
          finishReason: 'tool_use',
          toolCalls: [{ id: 'c', name: 'n', input: {} }],
          usage: { inputTokens: 1, outputTokens: 1 },
        } as ProviderResponse;
      },
    } as ModelProvider;
    const run = await runAgent(provider, 'q', {
      ...base,
      maxWallClockMs: 100,
      clock: () => t,
      executeTool: () => {
        t += 150; // the tool alone uses the whole budget
        return { isError: false, content: 'ok' };
      },
    });
    assert.equal(run.stoppedBy, 'wall_clock');
    assert.equal(calls, 1, 'no second model call after the deadline');
    assert.equal(run.toolCalls.length, 1, 'a tool that did finish is still on the record (it had effects)');
  });

  it('a tool that never returns is abandoned at the cap and not recorded as finished', async () => {
    const provider = {
      id: 'p',
      describeCapabilities: () => ({}) as never,
      complete: async () =>
        ({
          text: '',
          finishReason: 'tool_use',
          toolCalls: [{ id: 'c', name: 'n', input: {} }],
          usage: { inputTokens: 1, outputTokens: 1 },
        }) as ProviderResponse,
    } as ModelProvider;
    const run = await runAgent(provider, 'q', { ...base, maxWallClockMs: 15, executeTool: () => new Promise(() => undefined) });
    assert.equal(run.stoppedBy, 'wall_clock');
    assert.equal(run.toolCalls.length, 0);
  });

  it('a token budget fails closed when the provider reports no usage (a {0,0} placeholder is not a measurement)', async () => {
    let calls = 0;
    const provider = {
      id: 'p',
      describeCapabilities: () => ({}) as never,
      complete: async () => {
        calls++;
        return { text: 'x', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 }, usageKnown: false } as ProviderResponse;
      },
    } as ModelProvider;
    const limited = await runAgent(provider, 'q', { ...base, maxTotalTokens: 100 });
    assert.equal(limited.stoppedBy, 'token_budget');
    const unlimited = await runAgent(provider, 'q', base);
    assert.equal(unlimited.text, 'x');
    assert.equal(calls, 2);
  });

  it('unset: behaviour is unchanged', async () => {
    const provider = { id: 'p', describeCapabilities: () => ({}) as never, complete: async () => resp('done') } as ModelProvider;
    const run = await runAgent(provider, 'q', base);
    assert.equal(run.text, 'done');
    assert.equal(run.stoppedBy, undefined);
  });
});

describe('LOW_RESOURCE', () => {
  it('is frozen and conservative', () => {
    assert.ok(Object.isFrozen(LOW_RESOURCE));
    assert.equal(LOW_RESOURCE.exemplarK, 0);
    assert.equal(LOW_RESOURCE.forEachConcurrency, 1);
  });
});
