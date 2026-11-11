/**
 * C2 - Linux Local Agent, end to end: real socket, real `LocalFilesystemConnector`, real C1 enforcement, real audit canonicalization and
 * (where state matters) the real durable `EiStateStore`. Nothing here is mock-only evidence; the only seams are an authorization port
 * that can be revoked, an audit recorder that can refuse a terminal record, and an `fsOps.open` that can be held to make a real read slow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DiscoveryErrorCode, EnvironmentInventory, EvidenceLedger, type EvidenceId } from '../src/index.js';
import { put } from './helpers.js';
import {
  SECRET,
  TerminalRefusingAudit,
  bootStore,
  principalIdForThisProcess,
  rawExchange,
  frameOf,
  reqId,
  sleep,
  withAgentEnv,
  type AgentEnv,
} from './support/agent-env.js';

const T = { timeout: 30_000, skip: process.platform !== 'linux' } as const;
const mkfifo = (path: string): void => {
  execSync(`mkfifo ${JSON.stringify(path)}`);
};
const noSecret = (value: unknown): void =>
  assert.ok(!JSON.stringify(value).includes(SECRET), 'file content must never appear in a response');

async function seed(env: AgentEnv): Promise<void> {
  await put(join(env.root, 'a.txt'), `hello ${SECRET}`);
  await put(join(env.root, 'dir', 'b.md'), '# notes');
  await put(join(env.outside, 'secret.txt'), SECRET);
}

const released = (env: AgentEnv): number => env.ledger.counts().released;
const quiet = (env: AgentEnv): void => {
  assert.equal(env.audit.events().filter((e) => e.outcome === 'completed').length, 0, 'no completed audit record');
  assert.equal(released(env), 0, 'nothing released');
};

// ── authorized access ─────────────────────────────────────────────────────────────────────────────────────────────────────

test(
  'authorized in-scope discover then acquire: audited, provenance-stamped, released, and the agent (not the caller) is the principal',
  T,
  async () => {
    await withAgentEnv({}, async (env) => {
      await seed(env);
      const d = await env.discover();
      assert.ok(d.ok, 'discover succeeds');
      if (!d.ok) return;
      assert.ok(d.value.evidence.length >= 2);
      for (const e of d.value.evidence) assert.equal(e.sensitivity, 'metadata', 'discovery yields metadata only');

      const a = await env.acquire(d.value.sourceId, ['a.txt', 'dir/b.md']);
      assert.ok(a.ok, 'acquire succeeds');
      if (!a.ok) return;
      assert.equal(a.value.evidence.length, 2);
      for (const e of a.value.evidence) {
        assert.equal(e.provenance.access.permission, 'filesystem.read');
        assert.equal(e.provenance.access.principal?.id, principalIdForThisProcess);
        assert.equal(env.ledger.isEligible(e.id), true, 'released evidence is eligible');
      }
      noSecret(a);
      noSecret(d);

      // every authorization request in the whole session was made by the agent's own authenticated principal
      assert.ok(env.authz.requests.length > 0);
      for (const r of env.authz.requests) assert.equal(r.principal?.id, principalIdForThisProcess);
      // discover and acquire each left an attempt AND a terminal record
      const events = env.audit.events();
      for (const op of ['discover', 'acquire_content'] as const) {
        assert.ok(
          events.some((e) => e.operation === op && e.phase === 'attempt'),
          `${op} attempt recorded`,
        );
        assert.ok(
          events.some((e) => e.operation === op && e.phase === 'terminal' && e.outcome === 'completed'),
          `${op} terminal recorded`,
        );
      }
      assert.deepEqual(env.audit.openAttempts(), []);
    });
  },
);

test(
  'discovery cannot yield content: a discover-only grant lists metadata, and acquire is refused without the read permission',
  T,
  async () => {
    await withAgentEnv({ grants: ['filesystem.list'] }, async (env) => {
      await seed(env);
      const d = await env.discover();
      assert.ok(d.ok);
      if (!d.ok) return;
      assert.ok(d.value.evidence.every((e) => e.kind !== 'document_content' && e.sensitivity === 'metadata'));
      noSecret(d);
      const before = JSON.stringify(env.deps.inventory.get(d.value.sourceId as never));
      const a = await env.acquire(d.value.sourceId, ['a.txt']);
      assert.equal(a.ok, false);
      if (!a.ok)
        assert.ok([DiscoveryErrorCode.AUTHORIZATION_DENIED, DiscoveryErrorCode.AUTHORIZATION_REQUIRED].includes(a.error.code as never));
      assert.equal(env.ledger.counts().released, d.value.evidence.length, 'only the discovery metadata was ever released');
      assert.equal(
        JSON.stringify(env.deps.inventory.get(d.value.sourceId as never)),
        before,
        'a refused acquire does not advance source state',
      );
    });
  },
);

// ── scope and containment ─────────────────────────────────────────────────────────────────────────────────────────────────

test('out-of-scope root is denied: no inventory record, no evidence, nothing released, no completed audit', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    const res = await env.discover(env.outside);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(env.deps.inventory.list().length, 0, 'first contact with an unauthorized root leaves no record');
    quiet(env);
  });
});

test('path traversal, absolute keys and a wrong-root acquire are refused before any read', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    const base = released(env);
    for (const key of ['../outside/secret.txt', 'dir/../../outside/secret.txt', '/etc/passwd', '..\\outside\\secret.txt', './a.txt']) {
      const a = await env.acquire(d.value.sourceId, [key]);
      assert.equal(a.ok, false, `refused: ${key}`);
      if (!a.ok) assert.equal(a.error.code, DiscoveryErrorCode.SCOPE_VIOLATION);
      noSecret(a);
    }
    // the same source id presented with a root outside the authorization is refused too
    const wrong = await env.acquire(d.value.sourceId, ['secret.txt'], env.outside);
    assert.equal(wrong.ok, false);
    assert.equal(released(env), base, 'nothing further was released');
  });
});

test('symlink escape is not followed: a link to an outside file yields no evidence and no content', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    await symlink(join(env.outside, 'secret.txt'), join(env.root, 'link.txt'));
    await symlink(env.outside, join(env.root, 'linkdir'));
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    assert.ok(!d.value.evidence.some((e) => e.resourceKey.startsWith('link')), 'links are not inventoried');
    for (const key of ['link.txt', 'linkdir/secret.txt']) {
      const a = await env.acquire(d.value.sourceId, [key]);
      assert.equal(a.ok, false, `refused: ${key}`);
      noSecret(a);
    }
  });
});

test('a hard link to an outside file and a FIFO are skipped, not read, and the FIFO does not hang the agent', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    await link(join(env.outside, 'secret.txt'), join(env.root, 'hard.txt'));
    mkfifo(join(env.root, 'pipe.txt'));
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    for (const [key, reason] of [
      ['hard.txt', 'hard_linked_file'],
      ['pipe.txt', 'not_regular_file'],
    ] as const) {
      const a = await env.acquire(d.value.sourceId, [key], env.root, { timeoutMs: 10_000 });
      assert.ok(a.ok, `${key}: handled`);
      if (!a.ok) return;
      assert.equal(a.value.evidence.length, 0);
      assert.equal((a.value.skipped as { byReason: Record<string, number> }).byReason[reason], 1);
      noSecret(a);
    }
  });
});

// ── identity ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a forged or mismatched principal in a request is rejected unread: the protocol has no identity field', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    const forged = [{ principal: { kind: 'human', id: 'admin' } }, { principalId: 'admin' }, { userId: 'root' }, { auth: 'Bearer x' }];
    let n = 0;
    for (const extra of forged) {
      const r = await rawExchange(
        env.socketPath,
        frameOf({ v: 1, id: reqId(++n), op: 'discover', scope: { kind: 'filesystem_root', root: env.root }, ...extra }),
      );
      const reply = r.responses[0] as { ok: boolean; error?: { code: string } };
      assert.equal(reply.ok, false);
      assert.equal(reply.error?.code, DiscoveryErrorCode.MALFORMED_INPUT);
    }
    assert.equal(env.authz.requests.length, 0, 'the gate was never consulted for a forged request');
    assert.equal(env.audit.events().length, 0);
    assert.equal(env.deps.inventory.list().length, 0);
  });
});

test('a caller cannot widen limits or add exclusions through the scope', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    const r = await rawExchange(
      env.socketPath,
      frameOf({
        v: 1,
        id: reqId(1),
        op: 'discover',
        scope: { kind: 'filesystem_root', root: env.root, limits: { maxContentBytes: 1e12 } },
      }),
    );
    const reply = r.responses[0] as { ok: boolean; error?: { code: string } };
    assert.equal(reply.ok, false);
    assert.equal(reply.error?.code, DiscoveryErrorCode.MALFORMED_INPUT);
    assert.equal(env.authz.requests.length, 0);
  });
});

// ── revocation and failure of the gate / audit / state ────────────────────────────────────────────────────────────────────

test('a revoked source blocks acquisition and leaves state and the ledger untouched', T, async () => {
  await withAgentEnv({ durable: true }, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    const before = {
      record: JSON.stringify(env.deps.inventory.get(d.value.sourceId as never)),
      ledger: JSON.stringify(env.ledger.exportEntries()),
    };
    env.authz.revoked = true;
    const a = await env.acquire(d.value.sourceId, ['a.txt']);
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.error.code, DiscoveryErrorCode.AUTHORIZATION_DENIED);
    assert.equal(
      JSON.stringify(env.deps.inventory.get(d.value.sourceId as never)),
      before.record,
      'failed operation did not advance source state',
    );
    assert.equal(JSON.stringify(env.ledger.exportEntries()), before.ledger, 'and released nothing');
    noSecret(a);
  });
});

test('fail closed when the gate answers nothing: an unauthorized agent reads nothing', T, async () => {
  await withAgentEnv({ grants: [] }, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.equal(d.ok, false);
    quiet(env);
  });
});

test('audit unavailable releases nothing, in memory and in the durable store after a restart', T, async () => {
  await withAgentEnv({ durable: true, audit: (inner) => new TerminalRefusingAudit(inner) }, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.equal(d.ok, false, 'a discover whose completion audit is refused is not a success');
    if (!d.ok)
      assert.ok(
        [DiscoveryErrorCode.EVIDENCE_QUARANTINED, DiscoveryErrorCode.AUDIT_UNAVAILABLE].includes(d.error.code as never),
        'and it names the audit failure, not a generic one',
      );
    assert.equal(released(env), 0);
    assert.equal(env.store?.diagnostics().ledgerCounts.released, 0, 'and nothing is released in the durable journal');
    await env.store?.close();
    const ledger = new EvidenceLedger();
    const reopened = await bootStore(env.stateDir, ledger, new EnvironmentInventory());
    assert.equal(ledger.counts().released, 0, 'still nothing released after restart');
    for (const entry of ledger.exportEntries()) assert.equal(ledger.isEligible(entry.id as EvidenceId), false);
    await reopened.close();
  });
});

test('a non-operational durable store refuses the request before the connector runs', T, async () => {
  await withAgentEnv({ durable: true }, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    await env.store?.close();
    const opens = env.hold.opens;
    const a = await env.acquire(d.value.sourceId, ['a.txt']);
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.error.code, DiscoveryErrorCode.STATE_UNAVAILABLE);
    assert.equal(env.hold.opens, opens, 'the connector never touched the filesystem');
  });
});

// ── malformed, oversized and unsupported ──────────────────────────────────────────────────────────────────────────────────

test('malformed, oversized, unsupported and ill-versioned requests fail safely and the agent keeps serving', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    const code = (r: { responses: readonly unknown[] }): string | undefined =>
      (r.responses[0] as { error?: { code: string } } | undefined)?.error?.code;

    // not JSON
    let r = await rawExchange(env.socketPath, Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{{{')]));
    assert.equal(code(r), DiscoveryErrorCode.MALFORMED_INPUT);
    // declared length far beyond the cap: refused from the header alone, before any payload is buffered
    r = await rawExchange(env.socketPath, Buffer.from([0xff, 0xff, 0xff, 0xff]));
    assert.equal(code(r), DiscoveryErrorCode.MALFORMED_INPUT);
    // zero-length frame
    r = await rawExchange(env.socketPath, Buffer.from([0, 0, 0, 0]));
    assert.equal(code(r), DiscoveryErrorCode.MALFORMED_INPUT);
    // unsupported operations, including anything that looks like a command
    for (const op of ['exec', 'shell', 'read', 'incremental_sync', 'DISCOVER']) {
      r = await rawExchange(env.socketPath, frameOf({ v: 1, id: reqId(1), op, command: 'id' }));
      assert.equal(code(r), DiscoveryErrorCode.UNSUPPORTED_OPERATION, op);
    }
    // wrong version, bad id, array / null bodies, bad scope and keys
    const bad: unknown[] = [
      { v: 2, id: reqId(2), op: 'discover', scope: { kind: 'filesystem_root', root: env.root } },
      { v: 1, id: 'x', op: 'discover', scope: { kind: 'filesystem_root', root: env.root } },
      [],
      null,
      { v: 1, id: reqId(3), op: 'discover', scope: { kind: 'other', root: env.root } },
      { v: 1, id: reqId(4), op: 'discover', scope: { kind: 'filesystem_root', root: `${env.root}\u0000x` } },
      { v: 1, id: reqId(5), op: 'acquire', sourceId: 'src_x', scope: { kind: 'filesystem_root', root: env.root }, resourceKeys: [] },
      {
        v: 1,
        id: reqId(6),
        op: 'acquire',
        sourceId: 'src_x',
        scope: { kind: 'filesystem_root', root: env.root },
        resourceKeys: Array(51).fill('a.txt'),
      },
      { v: 1, id: reqId(7), op: 'acquire', sourceId: 'src_x', scope: { kind: 'filesystem_root', root: env.root }, resourceKeys: [5] },
    ];
    for (const message of bad) {
      r = await rawExchange(env.socketPath, frameOf(message), 250);
      assert.equal(r.responses.length, 1);
      assert.equal((r.responses[0] as { ok: boolean }).ok, false);
    }
    assert.equal(env.authz.requests.length, 0, 'not one of them reached the gate');
    // the agent is unharmed
    const good = await env.discover();
    assert.ok(good.ok);
  });
});

// ── cancellation, timeout, shutdown ───────────────────────────────────────────────────────────────────────────────────────

for (const blind of [false, true]) {
  const mode = blind ? 'connector ignores the signal' : 'connector honours the signal';
  const contained = blind ? 1 : 0; // a blind connector completes its read after the abort, so the agent must quarantine what it released

  test(`client cancel returns an error and nothing is left released (${mode})`, T, async () => {
    await withAgentEnv({ signalBlind: blind }, async (env) => {
      await seed(env);
      const d = await env.discover();
      assert.ok(d.ok);
      if (!d.ok) return;
      const releasedBefore = released(env);
      env.hold.engage();
      const ctl = new AbortController();
      const pending = env.acquire(d.value.sourceId, ['a.txt'], env.root, { signal: ctl.signal });
      await sleep(100);
      ctl.abort();
      const res = await pending;
      assert.equal(res.ok, false, 'a cancelled request is never a success');
      if (!res.ok) assert.equal(res.error.code, DiscoveryErrorCode.CANCELLED);
      env.hold.free(); // the real connector now completes its read and releases evidence...
      await sleep(300);
      assert.equal(released(env), releasedBefore, '...and nothing new is released');
      assert.equal(env.ledger.counts().quarantined, contained);
      assert.equal(env.agent.containmentFailures, 0);
    });
  });

  test(`timeout is an error, not a success (${mode})`, T, async () => {
    await withAgentEnv({ signalBlind: blind, agent: { requestTimeoutMs: 200 } }, async (env) => {
      await seed(env);
      const d = await env.discover();
      assert.ok(d.ok);
      if (!d.ok) return;
      const releasedBefore = released(env);
      env.hold.engage();
      const started = Date.now();
      const res = await env.acquire(d.value.sourceId, ['a.txt']);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.error.code, DiscoveryErrorCode.LIMIT_EXCEEDED);
        assert.equal(res.error.context['limit'], 'request_timeout');
      }
      assert.ok(Date.now() - started < 5_000, 'it answered at the deadline, without waiting for the stuck read');
      env.hold.free();
      await sleep(300);
      assert.equal(released(env), releasedBefore);
      assert.equal(env.ledger.counts().quarantined, contained);
    });
  });

  test(`a client that disconnects mid-request cancels it; nothing is delivered or left released (${mode})`, T, async () => {
    await withAgentEnv({ signalBlind: blind }, async (env) => {
      await seed(env);
      const d = await env.discover();
      assert.ok(d.ok);
      if (!d.ok) return;
      const releasedBefore = released(env);
      env.hold.engage();
      await rawExchange(
        env.socketPath,
        frameOf({
          v: 1,
          id: reqId(9),
          op: 'acquire',
          sourceId: d.value.sourceId,
          scope: { kind: 'filesystem_root', root: env.root },
          resourceKeys: ['a.txt'],
        }),
        150,
      ); // closes the connection without reading the answer
      env.hold.free();
      await sleep(300);
      assert.equal(released(env), releasedBefore);
      assert.equal(env.ledger.counts().quarantined, contained);
    });
  });
}

test('shutdown mid-flight aborts the request as an error, leaves no released evidence and removes the socket', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    const releasedBefore = released(env);
    env.hold.engage();
    const pending = env.acquire(d.value.sourceId, ['a.txt']);
    await sleep(100);
    const stopped = env.agent.stop();
    const res = await pending;
    assert.equal(res.ok, false);
    env.hold.free();
    await stopped;
    await sleep(200);
    assert.equal(released(env), releasedBefore);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(env.socketPath), false, 'socket file removed');
    await env.agent.stop(); // idempotent
    const after = await env.discover();
    assert.equal(after.ok, false, 'a stopped agent cannot be reached');
  });
});

test('a connection that sends half a frame and stalls is dropped at the frame deadline', T, async () => {
  await withAgentEnv({ agent: { frameDeadlineMs: 150 } }, async (env) => {
    const r = await rawExchange(env.socketPath, Buffer.from([0, 0, 0, 40, 0x7b]), 700, true);
    assert.equal(r.closed, true, 'the agent closed the stalled connection');
  });
});

test('connection and in-flight limits are enforced and do not disturb other callers', T, async () => {
  await withAgentEnv({ agent: { maxConnections: 2, maxInFlightPerConnection: 1 } }, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    env.hold.engage();
    const message = (n: number) =>
      frameOf({
        v: 1,
        id: reqId(n),
        op: 'acquire',
        sourceId: d.value.sourceId,
        scope: { kind: 'filesystem_root', root: env.root },
        resourceKeys: ['a.txt'],
      });
    // two requests on ONE connection with a limit of one in flight: the second is refused
    const two = await rawExchange(env.socketPath, Buffer.concat([message(1), message(2)]), 300);
    const refused = two.responses.find((x) => (x as { id: string }).id === reqId(2)) as
      { ok: boolean; error?: { code: string } } | undefined;
    assert.equal(refused?.error?.code, DiscoveryErrorCode.LIMIT_EXCEEDED);
    env.hold.free();
  });
});

// ── idempotency ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('an identical repeated request is idempotent: same answer, no second read, no second audit record, no second release', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    const id = reqId(42);
    const first = await env.acquire(d.value.sourceId, ['a.txt'], env.root, { id });
    assert.ok(first.ok);
    const events = env.audit.events().length;
    const opens = env.hold.opens;
    const requests = env.authz.requests.length;
    const again = await env.acquire(d.value.sourceId, ['a.txt'], env.root, { id });
    assert.deepEqual(again, first);
    assert.equal(env.audit.events().length, events);
    assert.equal(env.hold.opens, opens);
    assert.equal(env.authz.requests.length, requests);

    // the same id with a different body is refused, never merged
    const other = await env.acquire(d.value.sourceId, ['dir/b.md'], env.root, { id });
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.error.code, DiscoveryErrorCode.MALFORMED_INPUT);
  });
});

test('a failed request is not cached: the same id can be retried once the cause is fixed', T, async () => {
  await withAgentEnv({}, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    const id = reqId(77);
    env.authz.revoked = true;
    const denied = await env.acquire(d.value.sourceId, ['a.txt'], env.root, { id });
    assert.equal(denied.ok, false);
    env.authz.revoked = false;
    const retried = await env.acquire(d.value.sourceId, ['a.txt'], env.root, { id });
    assert.ok(retried.ok, 'a transient or corrected failure is not frozen into the cache');
  });
});

// ── durability across restart ─────────────────────────────────────────────────────────────────────────────────────────────

test('released evidence is durable: it survives an agent and store restart and stays eligible', T, async () => {
  await withAgentEnv({ durable: true }, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    const a = await env.acquire(d.value.sourceId, ['a.txt']);
    assert.ok(a.ok);
    if (!a.ok) return;
    await env.agent.stop();
    await env.store?.close();
    const ledger = new EvidenceLedger();
    const reopened = await bootStore(env.stateDir, ledger, new EnvironmentInventory());
    for (const e of a.value.evidence) assert.equal(ledger.isEligible(e.id), true);
    await reopened.close();
  });
});

// ── enforcement added by the agent itself ─────────────────────────────────────────────────────────────────────────────────

test('a cancel message on an open connection aborts that request: it answers CANCELLED and releases nothing', T, async () => {
  await withAgentEnv({ signalBlind: true }, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.ok(d.ok);
    if (!d.ok) return;
    const releasedBefore = released(env);
    env.hold.engage();
    const request = {
      v: 1,
      id: reqId(31),
      op: 'acquire',
      sourceId: d.value.sourceId,
      scope: { kind: 'filesystem_root', root: env.root },
      resourceKeys: ['a.txt'],
    };
    const cancel = { v: 1, op: 'cancel', id: reqId(31) };
    const r = await rawExchange(env.socketPath, Buffer.concat([frameOf(request), frameOf(cancel)]), 400, true);
    const reply = r.responses.find((x) => (x as { id: string }).id === reqId(31)) as { ok: boolean; error?: { code: string } } | undefined;
    assert.equal(reply?.ok, false);
    assert.equal(reply?.error?.code, DiscoveryErrorCode.CANCELLED);
    env.hold.free();
    await sleep(300);
    assert.equal(released(env), releasedBefore);
  });
});

test('a result larger than the response cap is withheld and contained, never truncated into a success', T, async () => {
  await withAgentEnv({ agent: { maxResponseBytes: 2048 } }, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.equal(d.ok, false, 'a discovery result over the cap is an error');
    if (!d.ok) {
      assert.equal(d.error.code, DiscoveryErrorCode.LIMIT_EXCEEDED);
      assert.equal(d.error.context['limit'], 'response_bytes');
    }
    assert.equal(released(env), 0, 'what the connector released was quarantined');
    assert.ok(env.ledger.counts().quarantined > 0);
  });
});

test('content-derived evidence in a discovery result is withheld and contained', T, async () => {
  await withAgentEnv({ leakContentInDiscovery: true }, async (env) => {
    await seed(env);
    const d = await env.discover();
    assert.equal(d.ok, false);
    assert.equal(released(env), 0);
    assert.ok(env.ledger.counts().quarantined > 0);
  });
});
