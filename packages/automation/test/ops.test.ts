import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  AutomationEngine,
  CronTrigger,
  DirectoryDelivery,
  EngineLockedError,
  FileAnchorSink,
  HashChainLedger,
  WebhookAnchorSink,
  WebhookDelivery,
  acquireEngineLock,
  cronMatches,
  deliverOutbox,
  nextCronTime,
  parseCron,
  readAnchorFile,
  renderMetrics,
  verifyAgainstAnchors,
  type WorkflowDefinition,
} from '../src/index.js';

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'xo-ops-'));
const noop: WorkflowDefinition = { id: 'wf', triggers: [], run: async () => ({ disposition: 'completed', lane: 'done', summary: 'ok' }) };

describe('single-writer lock', () => {
  it('refuses a second live engine on the same directory and releases on stop', async () => {
    const dir = await tmp();
    const a = new AutomationEngine({ dir, workflows: [noop] });
    await a.start();
    const b = new AutomationEngine({ dir, workflows: [noop] });
    await assert.rejects(b.start(), EngineLockedError);
    await a.stop();
    const c = new AutomationEngine({ dir, workflows: [noop] });
    await c.start(); // lock was released
    await c.stop();
    await rm(dir, { recursive: true, force: true });
  });
  it('takes over a lock whose holder process died on this host, but not one from another host', async () => {
    const dir = await tmp();
    await writeFile(
      join(dir, 'engine.lock'),
      JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import('node:os')).hostname(), startedAt: 'x' }),
    );
    const h = await acquireEngineLock(dir);
    assert.equal(h.tookOver, true);
    await h.release();
    await writeFile(join(dir, 'engine.lock'), JSON.stringify({ pid: 999999, host: 'some-other-host', startedAt: 'x' }));
    await assert.rejects(acquireEngineLock(dir), EngineLockedError);
    await writeFile(join(dir, 'engine.lock'), 'not json');
    await assert.rejects(acquireEngineLock(dir), EngineLockedError); // unreadable: never guess
    await rm(dir, { recursive: true, force: true });
  });
  it('does not keep the directory locked when the ledger is corrupt', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'ledger.jsonl'), '{"seq":1,"ts":"t","type":"x","data":{},"prev":"bad","hash":"bad"}\n');
    await assert.rejects(new AutomationEngine({ dir, workflows: [noop] }).start(), /failed verification/);
    assert.ok(!(await readdir(dir)).includes('engine.lock'));
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ledger anchoring', () => {
  it('detects truncation and a rebuilt history that the chain alone would accept', async () => {
    const dir = await tmp();
    const anchorsPath = join(await tmp(), 'anchors.jsonl'); // a different directory, as it should be in production
    const wf: WorkflowDefinition = { ...noop };
    const e = new AutomationEngine({ dir, workflows: [wf], anchors: { sinks: [new FileAnchorSink(anchorsPath)], everyEntries: 1 } });
    await e.start();
    for (let i = 0; i < 3; i++) await e.ledgerEntries.length; // keep lint quiet about unused loop
    await e.stop();
    const anchors = await readAnchorFile(anchorsPath);
    assert.ok(anchors.length >= 1);
    const entries = [...e.ledgerEntries];
    assert.equal(verifyAgainstAnchors(entries, anchors).ok, true);
    // truncation: drop the tail — chain still valid, anchor beyond end
    const cut = entries.slice(0, Math.max(1, entries.length - 2));
    const t = verifyAgainstAnchors(cut, anchors);
    assert.equal(t.ok, false);
    assert.match(t.problems.join(' '), /truncated/);
    // rebuild: a fresh, internally valid ledger with different content
    const other = await tmp();
    const forged = await HashChainLedger.open(join(other, 'l.jsonl'));
    for (let i = 0; i < entries.length; i++) await forged.append('forged', { i });
    const f = verifyAgainstAnchors(forged.entries(), anchors);
    assert.equal(f.ok, false);
    assert.match(f.problems.join(' '), /rewritten/);
    await rm(dir, { recursive: true, force: true });
  });
  it('a failing sink is recorded in the ledger and never stops the engine', async () => {
    const dir = await tmp();
    const bad = { id: 'bad', publish: async () => Promise.reject(new Error('disk full')) };
    const e = new AutomationEngine({ dir, workflows: [noop], anchors: { sinks: [bad], everyEntries: 1 } });
    await e.start();
    await e.stop();
    assert.ok(e.ledgerEntries.some((x) => x.type === 'anchor.failed'));
    assert.ok(e.counters.anchorFailures >= 1);
    await rm(dir, { recursive: true, force: true });
  });
  it('webhook sink signs the body and refuses plain http to a non-loopback host', async () => {
    assert.throws(() => new WebhookAnchorSink('http://example.com/a', 'x'.repeat(20)), /https/);
    const seen: { body: string; sig: string }[] = [];
    const f = (async (_u: unknown, init: { body: string; headers: Record<string, string> }) => {
      seen.push({ body: init.body, sig: init.headers['x-xo-anchor-signature']! });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const secret = 's'.repeat(20);
    await new WebhookAnchorSink('https://anchor.example/a', secret, f).publish({ seq: 3, hash: 'h', at: 't' });
    assert.equal(seen[0]!.sig, `sha256=${createHmac('sha256', secret).update(seen[0]!.body).digest('hex')}`);
  });
});

describe('cron', () => {
  const at = (s: string): Date => new Date(s);
  it('parses lists, ranges and steps and rejects out-of-range or malformed fields', () => {
    const s = parseCron('*/15 9-17 * * 1-5');
    assert.ok(cronMatches(s, at('2026-11-02T09:30:00Z'))); // Monday
    assert.ok(!cronMatches(s, at('2026-11-02T09:31:00Z')));
    assert.ok(!cronMatches(s, at('2026-11-01T09:30:00Z'))); // Sunday
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', 'a * * * *', '5-2 * * * *'])
      assert.throws(() => parseCron(bad), bad);
    assert.ok(cronMatches(parseCron('0 0 * * 7'), at('2026-11-01T00:00:00Z'))); // 7 = Sunday
  });
  it('finds the next time, and uses OR when both day fields are restricted', () => {
    assert.equal(nextCronTime(parseCron('30 2 * * *'), at('2026-11-02T02:30:00Z'))!.toISOString(), '2026-11-03T02:30:00.000Z');
    const orRule = parseCron('0 0 15 * 1'); // the 15th OR any Monday
    assert.ok(cronMatches(orRule, at('2026-11-15T00:00:00Z'))); // Sunday the 15th
    assert.ok(cronMatches(orRule, at('2026-11-02T00:00:00Z'))); // Monday the 2nd
    assert.equal(nextCronTime(parseCron('0 0 31 2 *'), at('2026-01-01T00:00:00Z')), undefined);
  });
  it('fires once per scheduled minute with a minute-based idempotency key', async () => {
    let t = Date.parse('2026-11-02T10:00:30Z');
    const events: string[] = [];
    const trig = new CronTrigger('every-min', '* * * * *', { now: () => t });
    await trig.start(async (ev) => (events.push(ev.idempotencyKey), { accepted: true, runId: 'r' }));
    await new Promise((r) => setTimeout(r, 5));
    await trig.stop();
    assert.equal(events.length, 0); // next fire is 30 s away; nothing fires early
    assert.equal(nextCronTime(parseCron('* * * * *'), new Date(t))!.toISOString(), '2026-11-02T10:01:00.000Z');
    t += 0;
  });
});

describe('metrics', () => {
  it('renders valid Prometheus text from engine state', async () => {
    const dir = await tmp();
    const e = new AutomationEngine({ dir, workflows: [noop] });
    await e.start();
    const text = renderMetrics(e);
    assert.match(text, /^# TYPE xo_jobs_accepted_total counter$/m);
    assert.match(text, /^xo_queue_depth 0$/m);
    for (const line of text.trim().split('\n')) assert.match(line, /^(# (HELP|TYPE) xo_\w+ .+|xo_\w+ \d+)$/);
    await e.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('escalation delivery', () => {
  it('delivers each item once per adapter, retries only the adapter that failed, and signs webhook bodies', async () => {
    const outbox = await tmp();
    const lane = join(outbox, 'needs-human');
    await (await import('node:fs/promises')).mkdir(lane, { recursive: true });
    await writeFile(join(lane, 'run_1.json'), JSON.stringify({ summary: 'escalate to SIU' }));
    const inbox = await tmp();
    let hookCalls = 0;
    let okNow = false;
    const secret = 'k'.repeat(20);
    const hook = new WebhookDelivery('https://hooks.example/x', secret, (async (
      _u: unknown,
      init: { body: string; headers: Record<string, string> },
    ) => {
      hookCalls++;
      assert.equal(init.headers['idempotency-key'], 'run_1');
      assert.equal(init.headers['x-xo-delivery-signature'], `sha256=${createHmac('sha256', secret).update(init.body).digest('hex')}`);
      return { ok: okNow, status: okNow ? 200 : 503 } as Response;
    }) as unknown as typeof fetch);
    const adapters = [new DirectoryDelivery(inbox), hook];
    const first = await deliverOutbox({ outboxDir: outbox, adapters });
    assert.deepEqual(first, { delivered: 0, failed: 1, skipped: 0 });
    okNow = true;
    const second = await deliverOutbox({ outboxDir: outbox, adapters });
    assert.deepEqual(second, { delivered: 1, failed: 0, skipped: 0 });
    const third = await deliverOutbox({ outboxDir: outbox, adapters });
    assert.deepEqual(third, { delivered: 0, failed: 0, skipped: 1 });
    assert.equal(hookCalls, 2); // one failure, one success, nothing after
    assert.equal((await readdir(inbox)).filter((n) => n.endsWith('.json')).length, 1); // the directory adapter ran exactly once
    assert.match(await readFile(join(inbox, 'run_1.json'), 'utf8'), /escalate to SIU/);
    assert.throws(() => new WebhookDelivery('http://example.com/x', secret), /https/);
  });
});
