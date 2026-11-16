// UW-3 — an uploaded email's attachments are opened as sources of their own, linked back to the email, through the same door as any upload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TestServer, withTempDir } from './test-helpers.js';
import { planEmailAttachments, safeAttachmentName, EMAIL_ATTACHMENT_LIMITS } from '../src/sources/email-attachments.js';
import type { EmailAttachmentRecord, SourceRecord } from '../src/sources/source.js';

interface Part {
  readonly type: string;
  readonly name?: string;
  readonly body: Buffer | string;
  readonly inlineId?: string;
}

/** A multipart/mixed email: a text body, then each part base64-encoded (as mail clients send attachments). */
function email(subject: string, parts: readonly Part[], boundary = `b-${subject.replace(/\W/g, '')}`): Buffer {
  const lines = [
    'From: Asha Rao <asha@example.com>',
    'To: claims@example.com',
    `Subject: ${subject}`,
    'Date: Tue, 10 Nov 2026 09:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please find the documents attached.',
  ];
  for (const p of parts) {
    const body = Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body, 'utf8');
    lines.push(`--${boundary}`, `Content-Type: ${p.type}${p.name !== undefined ? `; name="${p.name}"` : ''}`);
    if (p.type === 'message/rfc822') {
      lines.push('', body.toString('latin1'));
      continue;
    }
    lines.push('Content-Transfer-Encoding: base64');
    if (p.inlineId !== undefined) lines.push(`Content-ID: <${p.inlineId}>`, 'Content-Disposition: inline');
    else lines.push(`Content-Disposition: attachment${p.name !== undefined ? `; filename="${p.name}"` : ''}`);
    lines.push('', body.toString('base64').replace(/(.{76})/g, '$1\r\n'));
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'latin1');
}

const CERTIFICATE = 'Certificate of Insurance\n\nThis is to certify that Asha Rao holds policy P-9. Valid until 31 March 2027.';
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(7)]);

async function withServer(fn: (c: { server: TestServer; base: string }) => Promise<void>): Promise<void> {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      await fn({ server, base: `/workspaces/${ws}` });
    } finally {
      await server.stop();
    }
  });
}

test('UW-3 email: readable attachments become linked sources; the rest are listed with the reason, and the email still stores', async () => {
  await withServer(async ({ server, base }) => {
    const raw = email('Claim 4471 documents', [
      { type: 'text/plain', name: 'certificate.txt', body: CERTIFICATE },
      { type: 'text/csv', name: 'claims.csv', body: 'claim,amount\nC-1,1200\nC-2,15000\n' },
      { type: 'application/pdf', body: '%PDF-1.4 not really a pdf' }, // unnamed: named from its type
      { type: 'application/vnd.ms-powerpoint', name: 'deck.pptx', body: 'slides' },
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'broken.docx', body: 'not a zip' },
      { type: 'image/png', name: 'logo.png', body: LOGO, inlineId: 'logo@sig' },
      { type: 'text/plain', name: 'certificate-copy.txt', body: CERTIFICATE },
    ]);
    const up = await server.request('POST', `${base}/sources?filename=claim-4471.eml`, raw);
    assert.equal(up.status, 201, up.bodyText);
    const rec = up.json<SourceRecord>();
    const byPart = new Map((rec.attachments ?? []).map((a) => [a.filename ?? `#${a.part}`, a] as const));
    const opened = (rec.attachments ?? []).filter((a) => a.sourceId !== undefined && a.notOpened === undefined);
    assert.deepEqual(
      opened.map((a) => a.filename ?? a.contentType),
      ['certificate.txt', 'claims.csv', 'application/pdf'],
    );
    assert.match(byPart.get('deck.pptx')!.notOpened!, /\.pptx is not a format this server reads/);
    assert.match(byPart.get('broken.docx')!.notOpened!, /could not be read/);
    assert.match(byPart.get('logo.png')!.notOpened!, /signature logo/);
    const copy = byPart.get('certificate-copy.txt')!;
    assert.equal(copy.sourceId, byPart.get('certificate.txt')!.sourceId, 'an identical file is stored once and pointed at');
    assert.match(copy.notOpened!, /identical to part/);
    assert.equal(rec.stats?.attachments, 7);
    assert.ok(
      rec.ingestNotes?.some((n) =>
        /^Opened 3 attachment\(s\) as their own sources: certificate\.txt, claims\.csv, attachment-[\d.]+\.pdf\.$/.test(n),
      ),
    );
    assert.ok(rec.ingestNotes?.some((n) => n.startsWith('Not opened: ') && n.includes('deck.pptx') && n.includes('broken.docx')));

    // Each opened attachment is a source of its own: the exact decoded bytes, linked to the email by id, digest and MIME part.
    const listed = (await server.request('GET', `${base}/sources`)).json<{ sources: SourceRecord[] }>().sources;
    assert.equal(listed.length, 4, 'the email and its three opened attachments');
    const cert = listed.find((s) => s.originalFilename === 'certificate.txt')!;
    assert.deepEqual(cert.origin, {
      kind: 'email-attachment',
      emailSourceId: rec.sourceId,
      emailDigestSha256: createHash('sha256').update(raw).digest('hex'),
      emailFilename: 'claim-4471.eml',
      part: byPart.get('certificate.txt')!.part,
    });
    assert.equal(cert.digestSha256, createHash('sha256').update(CERTIFICATE).digest('hex'));
    assert.equal(listed.find((s) => s.originalFilename === 'claims.csv')!.stats?.rows, 2, 'read at the door like a direct upload');
    const content = await server.request('GET', `${base}/sources/${cert.sourceId}/content`);
    assert.equal(content.bodyText, CERTIFICATE);

    // ...and compiles like any upload.
    const compiled = await server.request('POST', `${base}/sources/${cert.sourceId}/compile`);
    const c = compiled.json<{ status: string; sourceReport?: { kindProposals: { kind: string }[] } }>();
    assert.equal(c.status, 'succeeded', compiled.bodyText);
    assert.equal(c.sourceReport?.kindProposals[0]?.kind, 'certificate');

    const audit = (await server.request('GET', `${base}/audit/events?event=source.extracted`)).json<{
      events: { target?: { id: string }; detail?: { fromEmail?: string } }[];
    }>().events;
    assert.equal(audit.length, 3);
    assert.ok(audit.every((e) => e.detail?.fromEmail === rec.sourceId));
  });
});

test('UW-3 email: a forwarded email is opened with its own attachments, but nesting stops two levels down', async () => {
  await withServer(async ({ server, base }) => {
    const tooDeep = email('level 4', [{ type: 'text/plain', name: 'never.txt', body: 'never' }]);
    const innermost = email('level 3', [
      { type: 'text/plain', name: 'original.txt', body: 'The original schedule.' },
      { type: 'message/rfc822', name: 'ancient.eml', body: tooDeep },
    ]);
    const inner = email('level 2', [
      { type: 'text/plain', name: 'endorsement.txt', body: 'Endorsement 2: the excess is 500.' },
      { type: 'message/rfc822', name: 'older.eml', body: innermost },
    ]);
    const outer = email('Fwd: level 2', [{ type: 'message/rfc822', name: 'forwarded.eml', body: inner }]);
    const up = await server.request('POST', `${base}/sources?filename=fwd.eml`, outer);
    assert.equal(up.status, 201, up.bodyText);
    const listed = (await server.request('GET', `${base}/sources`)).json<{ sources: SourceRecord[] }>().sources;
    const names = listed.map((s) => s.originalFilename).sort();
    assert.deepEqual(names, ['endorsement.txt', 'forwarded.eml', 'fwd.eml', 'older.eml', 'original.txt'].sort());
    const forwarded = listed.find((s) => s.originalFilename === 'forwarded.eml')!;
    assert.equal(forwarded.origin?.kind, 'email-attachment');
    const older = listed.find((s) => s.originalFilename === 'older.eml')!;
    const ancient = older.attachments?.find((a: EmailAttachmentRecord) => a.filename === 'ancient.eml');
    assert.match(ancient?.notOpened ?? '', /nested more than 2 levels deep/);
    const endorsement = listed.find((s) => s.originalFilename === 'endorsement.txt')!;
    assert.equal(endorsement.origin?.kind === 'email-attachment' ? endorsement.origin.emailSourceId : undefined, forwarded.sourceId);
  });
});

test('UW-3 email: at most 20 attachments are opened per email; the rest are listed', async () => {
  await withServer(async ({ server, base }) => {
    const parts = Array.from({ length: 24 }, (_, i) => ({ type: 'text/plain', name: `note-${i + 1}.txt`, body: `note ${i + 1}` }));
    const up = await server.request('POST', `${base}/sources?filename=many.eml`, email('many', parts));
    assert.equal(up.status, 201, up.bodyText);
    const rec = up.json<SourceRecord>();
    assert.equal(rec.attachments?.filter((a) => a.notOpened === undefined).length, EMAIL_ATTACHMENT_LIMITS.maxOpened);
    assert.ok(rec.attachments?.slice(20).every((a) => /only the first 20/.test(a.notOpened ?? '')));
  });
});

test('UW-3 email: attachment names from inside a message are untrusted and cleaned', () => {
  assert.equal(safeAttachmentName('../../etc/passwd'), 'passwd');
  assert.equal(safeAttachmentName('C:\\Users\\a\\scan.PDF'), 'scan.PDF');
  assert.equal(safeAttachmentName('..'), undefined);
  assert.equal(safeAttachmentName('a\u0000b..txt'), 'ab.txt');
  assert.equal(safeAttachmentName(`${'x'.repeat(300)}.pdf`)!.length, 200);
  const plans = planEmailAttachments(
    [{ filename: 'scan', contentType: 'application/pdf', size: 3, sha256: 'a', part: '2', inline: false, content: new Uint8Array(3) }],
    0,
  );
  assert.deepEqual(
    plans.map((p) => (p.open ? [p.filename, p.extension] : p.reason)),
    [['scan.pdf', '.pdf']],
    'named from its declared type',
  );
});
