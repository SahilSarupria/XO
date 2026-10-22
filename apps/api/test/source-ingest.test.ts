import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { TestServer, withTempDir } from './test-helpers.js';
import { DocxError, extractDocxText } from '../src/sources/docx-text.js';
import { isPublicAddress, safeFetch, validateImportUrl, type LookupFn, type TransportFn, type TransportRequest } from '../src/sources/safe-fetch.js';

// ---------------------------------------------------------------- a minimal ZIP/.docx writer (test only)

function zip(files: Record<string, string>, opts: { store?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const method = opts.store ? 0 : 8;
    const body = opts.store ? data : deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (t: string, style?: string, list = false) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const docx = (body: string, extra: Record<string, string> = {}) => zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`, ...extra });

// ---------------------------------------------------------------- docx extraction

test('docx: headings, paragraphs, lists, tables and entities become plain text; limits are reported', () => {
  const body =
    p('Claims SOP', 'Heading1') +
    p('Escalate when the claim exceeds the limit &amp; no proof exists.') +
    p('Check the policy is active', undefined, true) +
    '<w:tbl><w:tr><w:tc>' + p('Item') + '</w:tc><w:tc>' + p('Limit | cap') + '</w:tc></w:tr><w:tr><w:tc>' + p('TV') + '</w:tc><w:tc>' + p('50,000') + '</w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:delText>removed text</w:delText></w:r></w:p>';
  const out = extractDocxText(docx(body, { 'word/footer1.xml': '<x/>' }));
  assert.match(out.text, /^# Claims SOP/);
  assert.ok(out.text.includes('Escalate when the claim exceeds the limit & no proof exists.'));
  assert.ok(out.text.includes('- Check the policy is active'));
  assert.ok(out.text.includes('| Item | Limit \\| cap |'));
  assert.ok(out.text.includes('| TV | 50,000 |'));
  assert.ok(!out.text.includes('removed text'), 'tracked deletions are excluded');
  assert.equal(out.stats.tableRows, 2);
  assert.ok(out.notes.some((n) => /numbering/i.test(n)), 'list numbering loss is disclosed');
  assert.ok(out.notes.some((n) => /footers/i.test(n)));
});

test('docx: stored (uncompressed) entries work too', () => {
  const stored = zip({ 'word/document.xml': `<w:document ${W}><w:body>${p('hello world')}</w:body></w:document>` }, { store: true });
  assert.match(extractDocxText(stored).text, /hello world/);
});

test('docx: refuses things that are not readable Word documents', () => {
  assert.throws(() => extractDocxText(Buffer.from('not a zip at all, just text')), DocxError);
  assert.throws(() => extractDocxText(zip({ 'other.xml': '<x/>' })), /word\/document\.xml is missing/);
  assert.throws(() => extractDocxText(docx('<w:p></w:p>')), /no extractable text/);
  const truncated = docx(p('x')).subarray(0, 40);
  assert.throws(() => extractDocxText(truncated), DocxError);
});

test('docx: a decompression bomb is refused rather than exhausting memory', () => {
  const huge = 'A'.repeat(35 * 1024 * 1024); // inflates past the 30 MB safety cap, compresses to a few KB
  assert.throws(() => extractDocxText(zip({ 'word/document.xml': huge })), DocxError);
});

// ---------------------------------------------------------------- SSRF defenses

test('address classification: private, loopback, link-local, metadata, mapped and embedded IPv4 are all refused', () => {
  const blocked = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', '2001:db8::1',
  ];
  for (const a of blocked) assert.equal(isPublicAddress(a), false, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(a), true, a);
  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('url validation: https only, no credentials, no odd ports, no private literals or local names', () => {
  for (const bad of [
    'http://example.com/a.pdf', 'ftp://example.com/a', 'file:///etc/passwd', 'https://user:pw@example.com/a', 'https://example.com:8443/a',
    'https://localhost/a', 'https://foo.localhost/a', 'https://db.internal/a', 'https://printer.local/a', 'https://127.0.0.1/a', 'https://[::1]/a',
    'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/a', 'not a url', '',
  ]) assert.throws(() => validateImportUrl(bad), `${bad} must be refused`);
  assert.equal(validateImportUrl('https://example.com/a.pdf').hostname, 'example.com');
});

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const okTransport: TransportFn = async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: new Uint8Array([1, 2, 3]) });

test('safeFetch: a name that resolves to ANY non-public address is refused, and the transport is never called', async () => {
  let called = 0;
  const transport: TransportFn = async (r) => { called++; return okTransport(r); };
  for (const answers of [['127.0.0.1'], ['93.184.216.34', '10.0.0.7'], ['169.254.169.254'], ['::1']]) {
    const lookup: LookupFn = async () => answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);
    await assert.rejects(() => safeFetch('https://evil.example/a.pdf', { lookup, transport }), /non-public/);
  }
  assert.equal(called, 0);
});

test('safeFetch: connects to the address it vetted (DNS is resolved once, not re-resolved by the transport)', async () => {
  let seen: TransportRequest | undefined;
  const out = await safeFetch('https://example.com/a.pdf', { lookup: publicLookup, transport: async (r) => { seen = r; return okTransport(r); } });
  assert.equal(seen?.address.address, '93.184.216.34');
  assert.equal(out.bytes.length, 3);
});

test('safeFetch: redirects are re-validated hop by hop and capped', async () => {
  const toPrivate: TransportFn = async () => ({ status: 302, headers: { location: 'https://127.0.0.1/secret' }, body: new Uint8Array() });
  await assert.rejects(() => safeFetch('https://example.com/a', { lookup: publicLookup, transport: toPrivate }), /not a public internet address/);
  const toHttp: TransportFn = async () => ({ status: 301, headers: { location: 'http://example.com/a' }, body: new Uint8Array() });
  await assert.rejects(() => safeFetch('https://example.com/a', { lookup: publicLookup, transport: toHttp }), /only https/);
  const rebinding: LookupFn = async (h) => (h === 'good.example' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '192.168.0.9', family: 4 }]);
  const hop: TransportFn = async () => ({ status: 302, headers: { location: 'https://internal-looking.example/x' }, body: new Uint8Array() });
  await assert.rejects(() => safeFetch('https://good.example/a', { lookup: rebinding, transport: hop }), /non-public/);
  const loop: TransportFn = async () => ({ status: 302, headers: { location: 'https://example.com/again' }, body: new Uint8Array() });
  await assert.rejects(() => safeFetch('https://example.com/a', { lookup: publicLookup, transport: loop }), /too many redirects/);
});

test('safeFetch: non-200, empty and oversized responses are refused', async () => {
  await assert.rejects(() => safeFetch('https://example.com/a', { lookup: publicLookup, transport: async () => ({ status: 404, headers: {}, body: new Uint8Array([1]) }) }), /HTTP 404/);
  await assert.rejects(() => safeFetch('https://example.com/a', { lookup: publicLookup, transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) }), /empty/);
  await assert.rejects(
    () => safeFetch('https://example.com/a', { lookup: publicLookup, transport: async () => ({ status: 200, headers: {}, body: new Uint8Array(20) }) }, { maxBytes: 10, timeoutMs: 1000, maxRedirects: 3 }),
    /larger than/,
  );
});

// ---------------------------------------------------------------- routes

async function withServer<T>(importFetch: { lookup?: LookupFn; transport?: TransportFn }, fn: (c: { server: TestServer; base: string }) => Promise<T>): Promise<T> {
  return withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, importFetch });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        return await fn({ server, base: `/workspaces/${ws}` });
      } finally {
        await server.stop();
      }
    }),
  );
}

const sopDocx = docx(p('Claims SOP', 'Heading1') + p('Escalate large claims to a senior handler.') + p('Verify the policy is active on the date of loss.'));

test('upload .docx: accepted, measured, notes disclosed; compile reads it as a document source', async () => {
  await withServer({}, async ({ server, base }) => {
    const res = await server.request('POST', `${base}/sources?filename=claims-sop.docx`, sopDocx);
    assert.equal(res.status, 201, res.bodyText);
    const rec = res.json<{ sourceId: string; extension: string; mediaType: string; stats?: { words: number }; origin?: { kind: string } }>();
    assert.equal(rec.extension, '.docx');
    assert.match(rec.mediaType, /wordprocessingml/);
    assert.ok((rec.stats?.words ?? 0) > 5);
    assert.equal(rec.origin?.kind, 'upload');
    const compiled = await server.request('POST', `${base}/sources/${rec.sourceId}/compile`);
    assert.ok(compiled.status === 201 || compiled.status === 200, `compile must not error out on a docx: ${compiled.status} ${compiled.bodyText}`);
    const body = compiled.json<{ status: string }>();
    assert.ok(body.status === 'succeeded' || body.status === 'failed');
  });
});

test('upload .docx: a corrupt or non-docx file is refused at the door with a 400', async () => {
  await withServer({}, async ({ server, base }) => {
    const bad = await server.request('POST', `${base}/sources?filename=fake.docx`, Buffer.from('plain text pretending to be word'));
    assert.equal(bad.status, 400);
    assert.match(bad.bodyText, /cannot read this \.docx/);
    assert.equal((await server.request('GET', `${base}/sources`)).json<{ sources: unknown[] }>().sources.length, 0, 'nothing was stored');
  });
});

test('csv and text uploads record row/word counts', async () => {
  await withServer({}, async ({ server, base }) => {
    const csv = (await server.request('POST', `${base}/sources?filename=past.csv`, Buffer.from('id,decision\n1,paid\n2,denied\n3,paid\n'))).json<{ stats: { rows: number } }>();
    assert.equal(csv.stats.rows, 3);
    const txt = (await server.request('POST', `${base}/sources?filename=n.txt`, Buffer.from('one two three'))).json<{ stats: { words: number } }>();
    assert.equal(txt.stats.words, 3);
  });
});

test('import from link: stores the file, records origin without the query string, and is audited', async () => {
  const transport: TransportFn = async () => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: new TextEncoder().encode('policy clause one two three') });
  await withServer({ lookup: publicLookup, transport }, async ({ server, base }) => {
    const res = await server.request('POST', `${base}/sources/import`, { url: 'https://docs.example.com/files/terms.txt?token=SECRET123' });
    assert.equal(res.status, 201, res.bodyText);
    const rec = res.json<{ originalFilename: string; origin: { kind: string; url: string }; stats: { words: number } }>();
    assert.equal(rec.originalFilename, 'terms.txt');
    assert.equal(rec.origin.url, 'https://docs.example.com/files/terms.txt');
    assert.ok(!res.bodyText.includes('SECRET123'));
    const audit = await server.request('GET', `${base}/audit/events?event=source.imported`);
    assert.equal(audit.json<{ events: unknown[] }>().events.length, 1);
    assert.ok(!audit.bodyText.includes('SECRET123'), 'a token in the query string never reaches the audit log');
  });
});

test('import from link: file type comes from the content type when the URL has no extension; unknown types are refused', async () => {
  const pdf: TransportFn = async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: new Uint8Array([37, 80, 68, 70]) });
  await withServer({ lookup: publicLookup, transport: pdf }, async ({ server, base }) => {
    const res = (await server.request('POST', `${base}/sources/import`, { url: 'https://example.com/download/12345' })).json<{ originalFilename: string; extension: string }>();
    assert.equal(res.originalFilename, '12345.pdf');
    assert.equal(res.extension, '.pdf');
  });
  const exe: TransportFn = async () => ({ status: 200, headers: { 'content-type': 'application/x-msdownload' }, body: new Uint8Array([77, 90]) });
  await withServer({ lookup: publicLookup, transport: exe }, async ({ server, base }) => {
    assert.equal((await server.request('POST', `${base}/sources/import`, { url: 'https://example.com/setup' })).status, 400);
  });
});

test('import from link: SSRF attempts through the route are refused and nothing is stored', async () => {
  let calls = 0;
  const transport: TransportFn = async () => { calls++; return okTransport({} as TransportRequest); };
  await withServer({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], transport }, async ({ server, base }) => {
    for (const url of ['https://evil.example/a.pdf', 'https://169.254.169.254/latest/meta-data/', 'http://example.com/a.pdf', 'https://localhost/a.pdf']) {
      assert.equal((await server.request('POST', `${base}/sources/import`, { url })).status, 400, url);
    }
    assert.equal((await server.request('POST', `${base}/sources/import`, {})).status, 400);
    assert.equal(calls, 0);
    assert.equal((await server.request('GET', `${base}/sources`)).json<{ sources: unknown[] }>().sources.length, 0);
  });
});

test('import from link: blocked in air-gapped mode, and for roles without author permission', async () => {
  await withServer({ lookup: publicLookup, transport: okTransport }, async ({ server, base }) => {
    const viewer = await server.issueAdditionalIdentity('v');
    await server.request('POST', `${base}/members`, { identityId: 'v', role: 'viewer' });
    assert.equal((await server.request('POST', `${base}/sources/import`, { url: 'https://example.com/a.pdf' }, TestServer.authHeader(viewer.apiKey))).status, 403);
    await server.request('PUT', `${base}/settings`, { airGapped: true });
    const res = await server.request('POST', `${base}/sources/import`, { url: 'https://example.com/a.pdf' });
    assert.equal(res.status, 412);
    assert.match(res.bodyText, /air-gapped/);
  });
});
