// UW-10 (ADR 0041): message.send across three tiers, against LOCAL FAKE providers only (no real Gmail, Graph or mail host was used).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ConnectorError,
  gmailConnector,
  graphConnector,
  messageIdFor,
  smtpMailConnector,
  type AttachmentStore,
  type Connector,
  type OperationContext,
} from '../src/index.js';
import { fakeGmail, fakeGraph, fakeImap, fakeSmtp, newMailbox } from './mail-fakes.js';

const FROM = 'office@firm.example';
const PDF = Buffer.from('%PDF-1.4 certificate for one person');
const SHA = createHash('sha256').update(PDF).digest('hex');
const store: AttachmentStore = { read: async (h) => (h === SHA ? PDF : undefined) };
const policy = () => ({ confirmed: new Set(['asha@client.example']), rules: { addresses: [], domains: [] } });
const common = {
  from: FROM,
  recipientPolicy: policy,
  attachments: store,
  maxAttachmentBytes: 20 * 1024 * 1024,
  limits: { pacingMs: 0, dailyCap: 400 },
};
const args = {
  to: ['asha@client.example'],
  subject: 'Your certificate',
  body: 'Attached.',
  attachments: [{ filename: 'asha.pdf', contentType: 'application/pdf', sha256: SHA }],
};
const ctx = (key: string): OperationContext => ({
  idempotencyKey: key,
  runId: 'r',
  stepId: 's',
  secret: () => '',
  signal: new AbortController().signal,
});
const noSleep = { sleep: async () => undefined };
const egressPolicy = { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true, maxRequestBytes: 40e6, maxResponseBytes: 1e6 };
const gmail = (baseUrl: string, extra: Partial<Parameters<typeof gmailConnector>[0]> = {}): Connector =>
  gmailConnector(
    {
      ...common,
      baseUrl,
      egress: { ...egressPolicy, allowedPorts: [Number(new URL(baseUrl).port)] },
      accessToken: async () => 'fake-token-123',
      canLookup: true,
      ...extra,
    },
    { ...noSleep, retry: { delaysMs: [0, 0] } },
  );

test('tier 2: SMTP sends an attachment with the deterministic Message-ID, and the Sent folder lookup finds it', async () => {
  const box = newMailbox();
  const smtp = await fakeSmtp(box);
  const imap = await fakeImap(box);
  try {
    const c = smtpMailConnector(
      {
        ...common,
        tier: 'smtp_imap',
        smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' },
        imap: { host: '127.0.0.1', port: imap.port, security: 'none', user: FROM, accessToken: 'fake-token' },
        auth: () => undefined,
      },
      { ...noSleep, retry: { delaysMs: [0, 0] } },
    );
    const out = (await c.operations['send']!.execute(args, ctx('key-1'))) as Record<string, unknown>;
    assert.equal(out['messageId'], messageIdFor('key-1', FROM));
    assert.deepEqual(out['delivery'], { status: 'accepted', basis: 'smtp_250', delivered: 'not_confirmed', bounces: 'not_tracked' });
    const data = box.messages[0]!.data;
    assert.ok(data.includes(`Message-ID: ${messageIdFor('key-1', FROM)}`));
    assert.ok(data.includes(PDF.toString('base64').slice(0, 40)), 'attachment bytes are in the message');
    assert.deepEqual(await c.operations['find_sent']!.execute({ key: 'key-1' }, ctx('x')), { found: true });
  } finally {
    await smtp.close();
    await imap.close();
  }
});

test('the same send goes through all three tiers with the same arguments and the same Message-ID (UAC-32)', async () => {
  const box = newMailbox();
  const smtp = await fakeSmtp(box);
  const imap = await fakeImap(box);
  const gm = await fakeGmail(newMailbox());
  try {
    const smtpCfg = { ...common, smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' as const }, auth: () => undefined };
    const t1 = gmail(gm.baseUrl);
    const t2 = smtpMailConnector(
      { ...smtpCfg, tier: 'smtp_imap', imap: { host: '127.0.0.1', port: imap.port, security: 'none', user: FROM, accessToken: 't' } },
      noSleep,
    );
    const t3 = smtpMailConnector({ ...smtpCfg, tier: 'send_only' }, noSleep);
    const outs = [];
    for (const c of [t1, t2, t3]) outs.push((await c.operations['send']!.execute(args, ctx('same-key'))) as Record<string, unknown>);
    assert.deepEqual(
      outs.map((o) => o['tier']),
      ['native_api', 'smtp_imap', 'send_only'],
    );
    assert.equal(new Set(outs.map((o) => o['messageId'])).size, 1);
    assert.equal(t3.operations['find_sent'], undefined, 'tier 3 has no lookup: an unknown outcome waits for a person');
  } finally {
    await smtp.close();
    await imap.close();
    await gm.close();
  }
});

test('attachment substitution, a missing file and an oversize total are refused before anything is sent', async () => {
  const box = newMailbox();
  const smtp = await fakeSmtp(box);
  try {
    const mk = (s: AttachmentStore, max = 20e6) =>
      smtpMailConnector(
        {
          ...common,
          attachments: s,
          maxAttachmentBytes: max,
          tier: 'send_only',
          smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' },
          auth: () => undefined,
        },
        noSleep,
      );
    for (const [s, max, why] of [
      [{ read: async () => Buffer.from('a different file') }, 20e6, /no longer matches/],
      [{ read: async () => undefined }, 20e6, /no longer available/],
      [store, 5, /size limit/],
    ] as const) {
      await assert.rejects(
        mk(s, max).operations['send']!.execute(args, ctx('k')),
        (e: unknown) => e instanceof ConnectorError && why.test(e.message) && e.effect === 'none',
      );
    }
    assert.equal(smtp.attempts(), 0, 'nothing reached the server');
  } finally {
    await smtp.close();
  }
});

test('recipients: default deny; a confirmed record or an explicit workspace rule allows; tampering is refused', async () => {
  const smtp = await fakeSmtp(newMailbox());
  try {
    const mk = (p: () => ReturnType<typeof policy>) =>
      smtpMailConnector(
        {
          ...common,
          recipientPolicy: p,
          tier: 'send_only',
          smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' },
          auth: () => undefined,
        },
        noSleep,
      );
    const denied = (to: unknown) => mk(policy).operations['send']!.execute({ ...args, to }, ctx('k'));
    await assert.rejects(denied(['stranger@evil.example']), (e) => e instanceof ConnectorError && e.effect === 'none');
    await assert.rejects(denied(['asha@client.example', 'stranger@evil.example']));
    await assert.rejects(denied('asha@client.example\r\nBcc: x@evil.example'));
    await assert.rejects(denied([]));
    await mk(() => ({ confirmed: new Set(), rules: { addresses: [], domains: ['client.example'] } })).operations['send']!.execute(
      args,
      ctx('k2'),
    );
    await mk(policy).operations['send']!.execute({ ...args, to: ['ASHA@Client.Example'] }, ctx('k3'));
    assert.equal(smtp.attempts(), 2);
  } finally {
    await smtp.close();
  }
});

test('tier 2 unknown outcome: a dropped connection is unknown, and the Sent lookup settles it either way without a resend', async () => {
  const box = newMailbox();
  const smtp = await fakeSmtp(box, { dropAtMessage: 1, storeOnDrop: true });
  const imap = await fakeImap(box, { appearAfterSearches: 1 }); // lookup lag: visible from the second search
  try {
    const c = smtpMailConnector(
      {
        ...common,
        tier: 'smtp_imap',
        smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' },
        imap: { host: '127.0.0.1', port: imap.port, security: 'none', user: FROM, accessToken: 't' },
        auth: () => undefined,
      },
      { ...noSleep, retry: { delaysMs: [0, 0] } },
    );
    await assert.rejects(
      c.operations['send']!.execute(args, ctx('lost')),
      (e: unknown) => e instanceof ConnectorError && e.effect === undefined,
      'no effect flag: it may have been delivered',
    );
    assert.deepEqual(await c.operations['find_sent']!.execute({ key: 'lost' }, ctx('x')), { found: true });
    assert.equal(imap.searches(), 2, 'found on the second try (lag)');
    assert.equal(smtp.attempts(), 1, 'never re-sent');
    // Not there after three tries: still an error (unknown), never "not sent".
    await assert.rejects(c.operations['find_sent']!.execute({ key: 'never-sent' }, ctx('x')), /person must confirm/);
    assert.equal(imap.searches(), 5);
  } finally {
    await smtp.close();
    await imap.close();
  }
});

test('UAC-8: 300 sends with a connection loss mid-batch: one unknown, no blind resend, no duplicates', async () => {
  const box = newMailbox();
  const smtp = await fakeSmtp(box, { dropAtMessage: 150, storeOnDrop: false });
  try {
    const c = smtpMailConnector(
      { ...common, tier: 'send_only', smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' }, auth: () => undefined },
      noSleep,
    );
    const unknown: number[] = [];
    for (let i = 1; i <= 300; i++) {
      try {
        await c.operations['send']!.execute(args, ctx(`batch-${i}`));
      } catch (e) {
        assert.ok(e instanceof ConnectorError);
        if (e.effect === undefined) unknown.push(i);
      }
    }
    assert.deepEqual(unknown, [150]);
    assert.equal(smtp.attempts(), 300, 'exactly one attempt per key');
    const ids = box.messages.map((m) => /^Message-ID: (.+)$/im.exec(m.data)![1]!);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate Message-ID');
    assert.equal(ids.length, 299);
  } finally {
    await smtp.close();
  }
});

test('Gmail: native send (JSON and upload paths), lookup by Message-ID, and no lookup without a read capability', async () => {
  const box = newMailbox();
  const gm = await fakeGmail(box);
  try {
    const c = gmail(gm.baseUrl);
    const out = (await c.operations['send']!.execute(args, ctx('g1'))) as Record<string, unknown>;
    assert.equal(out['providerId'], 'g1');
    assert.equal(out['tier'], 'native_api');
    assert.deepEqual(await c.operations['find_sent']!.execute({ key: 'g1' }, ctx('x')), { found: true });
    await assert.rejects(c.operations['find_sent']!.execute({ key: 'unsent' }, ctx('x')), /person must confirm/);
    // A large attachment takes the media upload path.
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    const bigSha = createHash('sha256').update(big).digest('hex');
    const cBig = gmail(gm.baseUrl, { attachments: { read: async () => big } });
    await cBig.operations['send']!.execute(
      { ...args, attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', sha256: bigSha }] },
      ctx('g2'),
    );
    assert.ok(gm.requests().some((r) => r.startsWith('POST /upload/gmail/v1/users/me/messages/send?uploadType=media')));
    assert.equal(gmail(gm.baseUrl, { canLookup: false }).operations['find_sent'], undefined);
  } finally {
    await gm.close();
  }
});

test('Gmail provider limit: the batch stops, later sends are refused untried, a 5xx is unknown, nothing is retried', async () => {
  const gm = await fakeGmail(newMailbox(), { limitAfter: 2 });
  try {
    const c = gmail(gm.baseUrl);
    await c.operations['send']!.execute(args, ctx('l1'));
    await c.operations['send']!.execute(args, ctx('l2'));
    await assert.rejects(
      c.operations['send']!.execute(args, ctx('l3')),
      (e) => e instanceof ConnectorError && /limit/.test(e.message) && e.effect === 'none',
    );
    const before = gm.requests().length;
    await assert.rejects(c.operations['send']!.execute(args, ctx('l4')), (e) => e instanceof ConnectorError && e.effect === 'none');
    assert.equal(gm.requests().length, before, 'the fourth send was not even tried');
  } finally {
    await gm.close();
  }
  const gm5 = await fakeGmail(newMailbox(), { fail500AfterStoring: true });
  try {
    await assert.rejects(
      gmail(gm5.baseUrl).operations['send']!.execute(args, ctx('five')),
      (e) => e instanceof ConnectorError && e.effect === undefined,
    );
    assert.equal(gm5.requests().length, 1);
  } finally {
    await gm5.close();
  }
});

test('pacing and the daily cap are enforced per connection', async () => {
  const smtp = await fakeSmtp(newMailbox());
  try {
    let now = 1_700_000_000_000;
    const waits: number[] = [];
    const c = smtpMailConnector(
      {
        ...common,
        limits: { pacingMs: 5000, dailyCap: 2 },
        tier: 'send_only',
        smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' },
        auth: () => undefined,
      },
      { now: () => now, sleep: async (ms) => void (waits.push(ms), (now += ms)) },
    );
    await c.operations['send']!.execute(args, ctx('p1'));
    await c.operations['send']!.execute(args, ctx('p2'));
    assert.deepEqual(waits, [5000]);
    await assert.rejects(
      c.operations['send']!.execute(args, ctx('p3')),
      (e) => e instanceof ConnectorError && /daily send cap/.test(e.message) && e.effect === 'none',
    );
    assert.equal(smtp.attempts(), 2);
  } finally {
    await smtp.close();
  }
});

test('errors never carry addresses, subjects, bodies or tokens', async () => {
  const gm = await fakeGmail(newMailbox(), { fail500AfterStoring: true });
  const smtp = await fakeSmtp(newMailbox(), { dropAtMessage: 1 });
  try {
    const errors: string[] = [];
    for (const c of [
      gmail(gm.baseUrl),
      smtpMailConnector(
        { ...common, tier: 'send_only', smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' }, auth: () => undefined },
        noSleep,
      ),
    ])
      await c.operations['send']!.execute(args, ctx('pii')).catch((e: Error) => errors.push(e.message));
    await gmail(gm.baseUrl, { recipientPolicy: () => ({ confirmed: new Set(), rules: { addresses: [], domains: [] } }) })
      .operations['send']!.execute(args, ctx('pii2'))
      .catch((e: Error) => errors.push(e.message));
    assert.equal(errors.length, 3);
    for (const m of errors) assert.ok(!/asha|client\.example|certificate|Attached|fake-token|office@/i.test(m), m);
  } finally {
    await gm.close();
    await smtp.close();
  }
});

test('Microsoft Graph: MIME send keeps the Message-ID, 202 is accepted not delivered, lookup needs a read capability, limits stop the batch', async () => {
  const box = newMailbox();
  const g = await fakeGraph(box, { limitAfter: 1 });
  try {
    const mk = (extra: Partial<Parameters<typeof graphConnector>[0]> = {}) =>
      graphConnector(
        {
          ...common,
          baseUrl: g.baseUrl,
          egress: { ...egressPolicy, allowedPorts: [Number(new URL(g.baseUrl).port)] },
          accessToken: async () => 'fake-token-9',
          canLookup: true,
          ...extra,
        },
        { ...noSleep, retry: { delaysMs: [0, 0] } },
      );
    const c = mk();
    const out = (await c.operations['send']!.execute(args, ctx('gr1'))) as Record<string, unknown>;
    assert.equal(out['messageId'], messageIdFor('gr1', FROM));
    assert.deepEqual((out['delivery'] as Record<string, unknown>)['delivered'], 'not_confirmed');
    assert.deepEqual(await c.operations['find_sent']!.execute({ key: 'gr1' }, ctx('x')), { found: true });
    await assert.rejects(
      c.operations['send']!.execute(args, ctx('gr2')),
      (e) => e instanceof ConnectorError && e.effect === 'none' && /limit/.test(e.message),
    );
    assert.equal(mk({ canLookup: false }).operations['find_sent'], undefined);
    const big = Buffer.alloc(4 * 1024 * 1024, 1);
    const bigSha = createHash('sha256').update(big).digest('hex');
    await assert.rejects(
      mk({ attachments: { read: async () => big } }).operations['send']!.execute(
        { ...args, attachments: [{ filename: 'b.bin', contentType: 'application/octet-stream', sha256: bigSha }] },
        ctx('gr3'),
      ),
      (e) => e instanceof ConnectorError && e.effect === 'none' && /larger than/.test(e.message),
    );
  } finally {
    await g.close();
  }
});

test('provider guess: known domain, then MX, else manual, each with the tier in plain words', async () => {
  const { guessProvider } = await import('../src/index.js');
  assert.equal((await guessProvider('a@gmail.com')).tier, 'native_api');
  assert.equal((await guessProvider('a@yahoo.com')).tier, 'smtp_imap');
  assert.deepEqual((await guessProvider('a@firm.example', { mx: async () => ['aspmx.l.google.com.'] })).provider, 'google');
  assert.equal(
    (await guessProvider('a@firm.example', { mx: async () => ['firm-example.mail.protection.outlook.com'] })).provider,
    'microsoft',
  );
  const manual = await guessProvider('a@firm.example', { mx: async () => ['mail.hosting.example'] });
  assert.equal(manual.tier, 'send_only');
  assert.match(manual.explanation, /cannot check what was sent/);
  assert.equal(
    (
      await guessProvider('a@down.example', {
        mx: async () => {
          throw new Error('nxdomain');
        },
      })
    ).how,
    'manual',
  );
});
