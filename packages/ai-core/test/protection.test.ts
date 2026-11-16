/**
 * UW-14c–e: the detectors (known values and pattern packs), reversible tokens and the leak guard.
 * Check digits use published vectors (sources in docs/RESIDENCY.md), never values computed by the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  gstinCheckChar,
  KnownValueDictionary,
  luhnValid,
  normalizeForMatch,
  ProtectionScanner,
  protectedIntentFilter,
  runWithProtection,
  scanRequest,
  sealVault,
  TokenVault,
  TokenVaultError,
  unsealVault,
  validate,
  vaultKey,
  verhoeffValid,
  guardProvider,
  resolveResidency,
  getInferenceDenial,
  type EgressDecision,
  type ModelProvider,
  type ProviderRequest,
} from '../src/index.js';

const dict = (): KnownValueDictionary => {
  const d = new KnownValueDictionary();
  d.add({ value: 'Ravi Kumar', kind: 'name' });
  d.add({ value: 'Meenakshi Sundaram', kind: 'name' });
  d.add({ value: 'Lakshmi Srivastava', kind: 'name' });
  d.add({ value: 'Shree Ganesh Traders Pvt Ltd', kind: 'organization' });
  d.add({ value: 'ravi.kumar@acme.in', kind: 'email' });
  d.add({ value: '+91 98200 12345', kind: 'phone' });
  d.add({ value: 'POL-4471102', kind: 'identifier' });
  return d;
};
const scanner = (): ProtectionScanner => new ProtectionScanner({ dictionary: dict() });
const entities = (s: ProtectionScanner, text: string): string[] => s.scan(text).map((h) => h.entity);

test('check digits: Verhoeff (Aadhaar), GSTIN mod-36 and Luhn agree with published vectors', () => {
  assert.equal(verhoeffValid('234123412346'), true, 'python-stdnum: valid Aadhaar');
  assert.equal(verhoeffValid('234123412347'), false, 'python-stdnum: one digit off');
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'.toLowerCase()), 'v', 'the GSTIN worked example 27AAPFU0939F1ZV');
  assert.equal(validate('gstin', '27AAPFU0939F1ZV'), true);
  assert.equal(validate('gstin', '27AAPFU0939F1ZW'), false, 'wrong check character');
  assert.equal(validate('gstin', '99AAPFU0939F1ZV'), false, 'no state 99');
  assert.equal(luhnValid('4111111111111111'), true, 'the standard Visa test number');
  assert.equal(luhnValid('4111111111111112'), false);
});

test('pattern packs: Indian identifiers are found with their validators, and look-alikes are not', () => {
  const s = new ProtectionScanner();
  assert.deepEqual(entities(s, 'Aadhaar 2341 2341 2346 on file'), ['AADHAAR']);
  assert.deepEqual(entities(s, 'Aadhaar 2341 2341 2347 on file'), [], 'the Verhoeff digit is wrong');
  assert.deepEqual(entities(s, 'ref 1234 5678 9012'), [], 'an Aadhaar never starts with 0 or 1');
  assert.deepEqual(entities(s, 'PAN ABCPE1234F'), ['PAN'], 'P (person) is a holder letter');
  assert.deepEqual(entities(s, 'code ABCXE1234F'), [], 'X is not a holder letter');
  assert.deepEqual(entities(s, 'GSTIN 27AAPFU0939F1ZV'), ['GSTIN']);
  assert.deepEqual(entities(s, 'IFSC HDFC0001234'), ['IFSC']);
  assert.deepEqual(entities(s, 'call +91 98200 12345'), ['PHONE']);
  assert.deepEqual(entities(s, 'call 9999999999'), [], 'one digit repeated is filler');
  assert.deepEqual(entities(s, 'pay ravi@okhdfcbank'), ['UPI']);
  assert.deepEqual(entities(s, 'mail asha@clientco.in'), ['EMAIL']);
  assert.deepEqual(entities(s, 'mail bcdf@example.invalid or x@example.com'), [], 'reserved domains hold no mailbox');
  assert.deepEqual(entities(s, 'passport J8369854'), ['PASSPORT']);
  assert.deepEqual(entities(s, 'order J8369854'), [], 'a passport number needs its context word');
  assert.deepEqual(entities(s, 'shape "AAAAA9999A"'), [], 'shape notation is a format, not a value');
});

test('known values: names in their written variants, misspelt, joined, in file names, in other scripts', () => {
  const s = scanner();
  for (const text of [
    'Send it to Ravi Kumar today',
    'RAVI KUMAR',
    'R. Kumar',
    'Kumar, Ravi',
    'Kumar R',
    'Meenaksi Sundaram', // one letter dropped
    'Meenakshi Sundarm',
    'Meneakshi Sundaram', // transposition
    'ravi_kumar_policy.pdf',
    'RaviKumarPolicy.xlsx',
    'statements/ravikumar/2026.pdf',
    'Rаvi Kumаr', // Cyrillic а
    'Ravi​Kumar', // zero-width space
    'Ｒａｖｉ Ｋｕｍａｒ', // full-width
    'Shree Ganesh Traders',
    'Laxmi Shrivastav', // another romanisation of both names
    'Lakshmi Srivastav',
  ])
    assert.ok(s.scan(text).length > 0, `found in ${JSON.stringify(text)}`);
  for (const text of ['Ravi went home', 'Kumar Sanu songs', 'Ravindra Kumaran', 'the trader in Ganesh nagar', 'Lakshmi puja on Friday'])
    assert.deepEqual(entities(s, text), [], `not in ${JSON.stringify(text)}`);
});

test('known values: identifiers whatever the separators; digits inside a longer number are a different number', () => {
  const s = scanner();
  // The dictionary and the email pattern both find the address; the name inside it is found too.
  assert.deepEqual([...new Set(entities(s, 'ravi.kumar@acme.in'))].sort(), ['EMAIL', 'PERSON']);
  assert.ok(entities(s, 'policy POL 4471102').includes('ID'));
  assert.ok(entities(s, 'policy pol4471102').includes('ID'));
  assert.ok(entities(s, 'mobile 9820012345').includes('PHONE'));
  assert.ok(entities(s, 'mobile 98200-12345').includes('PHONE'), 'the national number, without +91');
  assert.deepEqual(entities(s, 'invoice 449820012345'), [], 'inside a longer number');
  assert.ok(
    !scanner()
      .scan('total 4471102 units')
      .some((h) => h.detector === 'dictionary'),
    'a bare number is not POL-4471102',
  );
});

test('encodings: base64 and percent-encoded values are found, and say so', () => {
  const s = scanner();
  const b64 = Buffer.from('client: Ravi Kumar, PAN ABCPE1234F').toString('base64');
  const hits = s.scan(`payload=${b64}`);
  assert.ok(hits.some((h) => h.encoded === 'base64' && h.entity === 'PERSON'));
  assert.ok(hits.some((h) => h.encoded === 'base64' && h.entity === 'PAN'));
  const url = Buffer.from('to Meenakshi Sundaram?').toString('base64url');
  assert.ok(
    s.scan(`/share/${url}`).some((h) => h.encoded === 'base64' && h.entity === 'PERSON'),
    'base64url',
  );
  assert.ok(s.scan('/files/Ravi%20Kumar%20statement.pdf').some((h) => h.encoded === 'percent'));
  assert.deepEqual(s.scan(randomBytes(48).toString('base64')), [], 'binary is not text');
});

test('hits carry hashes, never values; the same value hashes the same in every written form', () => {
  const s = scanner();
  const a = s.scan('Ravi Kumar')[0]!;
  const b = s.scan('R Kumar')[0]!;
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^sha256:[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(s.scan('Ravi Kumar ABCPE1234F')).toLowerCase().includes('ravi'));
  assert.ok(!JSON.stringify(s.scan('Ravi Kumar ABCPE1234F')).toLowerCase().includes('abcpe'));
});

test('normalisation keeps a map back to the original text', () => {
  const n = normalizeForMatch('Ｒａｖｉ');
  assert.equal(n.text, 'ravi');
  const s = scanner();
  const text = 'to: Rаvi Kumаr.';
  const h = s.scan(text)[0]!;
  assert.equal(text.slice(h.start, h.end), 'Rаvi Kumаr');
});

test('masking and the protected intent filter: a customer named in a goal never reaches the model', () => {
  const s = scanner();
  assert.equal(s.mask('Email Ravi Kumar (ABCPE1234F) at ravi.kumar@acme.in').text, 'Email [PERSON] ([PAN]) at [EMAIL]');
  const f = protectedIntentFilter(s);
  const out = f.apply('Remind Meenakshi Sundaram about policy POL-4471102 on 31 March');
  assert.ok(!/meenakshi|sundaram|4471102/i.test(out.text), out.text);
  assert.ok(out.replaced >= 2);
});

test('UAC-26: the token vault — stable placeholders, values back only where declared, invented ones refused', () => {
  const vault = TokenVault.create('wf_1', new Date('2026-11-16T00:00:00Z'), 30);
  const s = scanner();
  const masked = s.mask('Send Ravi Kumar and R. Kumar the note; cc Meenakshi Sundaram', (h, orig) =>
    vault.tokenize(orig, h.entity === 'PERSON' ? 'CLIENT' : h.entity, h.hash),
  );
  assert.equal(masked.text, 'Send CLIENT_0001 and CLIENT_0001 the note; cc CLIENT_0002');

  const out = vault.reidentify(
    { greeting: 'Dear CLIENT_0001', addressee: 'CLIENT_0002', to: '', amount: null },
    {
      addressee: { kind: 'entity', entity: 'CLIENT' },
      greeting: { kind: 'text' },
      to: { kind: 'forbidden', reason: 'recipients come from resolved data' },
      amount: { kind: 'forbidden', reason: 'amounts come from resolved data' },
    },
  );
  assert.equal(out.addressee, 'Meenakshi Sundaram');
  assert.equal(out.greeting, 'Dear CLIENT_0001', 'free text keeps its placeholders');

  const reject = (o: unknown, code: TokenVaultError['code']) =>
    assert.throws(
      () => vault.reidentify(o, { addressee: { kind: 'entity', entity: 'CLIENT' }, to: { kind: 'forbidden', reason: 'r' } }),
      (e: unknown) => e instanceof TokenVaultError && e.code === code,
    );
  reject({ addressee: 'CLIENT_0007' }, 'unknown_placeholder');
  reject({ addressee: 'Ravi Kumar' }, 'unknown_placeholder');
  reject({ note: 'also tell CLIENT_0003' }, 'unknown_placeholder');
  reject({ note: 'tell PERSON_0001' }, 'unknown_placeholder');
  reject({ note: 'tell CLIENT_1' }, 'malformed');
  reject({ note: 'tell client_0001' }, 'malformed');
  reject({ to: 'someone@evil.example' }, 'forbidden_field');
  assert.doesNotThrow(() => vault.reidentify({ note: 'ISO_9001 and COVID_2019 are just text' }, {}));
});

test('UAC-26: a vault is sealed per workspace, refuses tampering, and is never serialised in the clear', () => {
  const master = randomBytes(32);
  const vault = TokenVault.create('wf_2', new Date(), 7);
  vault.tokenize('Ravi Kumar', 'CLIENT');
  const key = vaultKey(master, 'ws_a');
  const sealed = sealVault(key, vault);
  assert.ok(!sealed.includes('Ravi'));
  assert.equal(unsealVault(key, sealed).resolve('CLIENT_0001')?.value, 'Ravi Kumar');
  assert.throws(
    () => unsealVault(vaultKey(master, 'ws_b'), sealed),
    (e: unknown) => e instanceof TokenVaultError && e.code === 'tampered',
  );
  const box = JSON.parse(sealed) as Record<string, string>;
  assert.throws(() => unsealVault(key, JSON.stringify({ ...box, scope: 'wf_other' })), /does not open/);
  assert.throws(() => JSON.stringify(vault), /never serialised/);
});

// ------------------------------------------------------------------------------------------------ the leak guard (UAC-24)

const capture = (id: string): ModelProvider & { bodies: string[] } => {
  const bodies: string[] = [];
  return {
    id,
    bodies,
    async complete(req: ProviderRequest) {
      bodies.push(JSON.stringify(req));
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' } as never;
    },
    async *completeStream(req: ProviderRequest) {
      bodies.push(JSON.stringify(req));
      yield { type: 'text_delta', delta: 'ok' } as const;
    },
  } as ModelProvider & { bodies: string[] };
};
const open = resolveResidency({ XO_RESIDENCY: 'open' });
const masked = resolveResidency({ XO_RESIDENCY: 'masked_hosted', XO_HOSTED_MODEL_PROVIDERS: 'anthropic' });
const req = (content: string): ProviderRequest => ({ model: 'm', messages: [{ role: 'user', content }], maxOutputTokens: 5 });

test('UAC-24: the leak guard blocks a hosted request carrying a protected value, anywhere and however disguised', async () => {
  const p = capture('anthropic');
  const decisions: EgressDecision[] = [];
  const blocked: string[] = [];
  const g = guardProvider(p, open, { onDecision: (d) => decisions.push(d) });
  const ctx = {
    scope: 'ws_1',
    scanner: async () => scanner(),
    onBlocked: (v: { hits: readonly { hash: string }[] }) => void blocked.push(...v.hits.map((h) => h.hash)),
  };
  await runWithProtection(ctx, async () => {
    for (const leak of [
      'Summarise the file for Ravi Kumar',
      'Attachment: ravi_kumar_statement.pdf',
      `blob ${Buffer.from('{"client":"Meenakshi Sundaram"}').toString('base64')}`,
      'Error: ENOENT /data/clients/RaviKumar/policy.pdf',
      'Aadhaar 2341 2341 2346',
    ]) {
      const e = await g.complete(req(leak)).catch((x: unknown) => x);
      assert.equal(getInferenceDenial(e)?.reason, 'leak_guard_blocked', leak);
      assert.ok(
        !String((e as Error).message)
          .toLowerCase()
          .includes('ravi'),
        'the refusal names no value',
      );
    }
    // In the system prompt, a tool definition, or a response schema: the request is scanned whole.
    const sys = { ...req('hello'), system: 'Customer: Ravi Kumar' } as ProviderRequest;
    assert.equal(getInferenceDenial(await g.complete(sys).catch((x: unknown) => x))?.reason, 'leak_guard_blocked');
    // The stream is refused before anything is sent.
    const it = g.completeStream!(req('for Ravi Kumar'))[Symbol.asyncIterator]();
    assert.equal(getInferenceDenial(await it.next().catch((x: unknown) => x))?.reason, 'leak_guard_blocked');

    await g.complete(req('Summarise the renewals due this month'));
  });
  assert.equal(p.bodies.length, 1, 'only the clean request left');
  assert.ok(blocked.length >= 7 && blocked.every((h) => /^sha256:/.test(h)));
  const denied = decisions.filter((d) => !d.allowed);
  assert.ok(denied.every((d) => d.hits !== undefined && !JSON.stringify(d).toLowerCase().includes('ravi')));
});

test('UAC-24: with no workspace context, hosted requests get the pattern packs in open mode and are refused in masked_hosted', async () => {
  const p = capture('anthropic');
  const g = guardProvider(p, open);
  assert.equal(getInferenceDenial(await g.complete(req('PAN ABCPE1234F')).catch((x: unknown) => x))?.reason, 'leak_guard_blocked');
  await g.complete(req('nothing here'));
  const m = guardProvider(capture('anthropic'), masked);
  assert.equal(getInferenceDenial(await m.complete(req('x')).catch((x: unknown) => x))?.reason, 'residency_untyped_egress');
  assert.equal(p.bodies.length, 1);
});

test('the leak guard leaves local models alone: they may see the workspace’s own data', async () => {
  const local = capture('ollama');
  const g = guardProvider(local, open, { endpoint: 'http://127.0.0.1:11434' });
  await runWithProtection({ scope: 'ws_1', scanner: async () => scanner() }, () => g.complete(req('Ravi Kumar ABCPE1234F')));
  assert.equal(local.bodies.length, 1);
});

test('scanRequest reports where each hit was, skipping the model id and request id', () => {
  const v = scanRequest(scanner(), { model: 'ravi-kumar', requestId: 'Ravi Kumar', messages: [{ role: 'user', content: 'hi R Kumar' }] });
  assert.equal(v.blocked, true);
  assert.deepEqual(
    v.hits.map((h) => h.path),
    ['$.messages[0].content'],
  );
});
