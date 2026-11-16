#!/usr/bin/env node
// UW-17 — smoke test for ANY running XO instance (local `xo up`, the container, a cloud instance). No dependencies.
//
//   node scripts/smoke-instance.mjs --url http://127.0.0.1:4000 --key xoak_... [--metrics-token <token>]
//
// It walks the certificate path as far as the platform goes today: the instance is alive and ready; a customer forwards an email with
// the certificate attached; the attachment is opened as its own source; compiling it proposes "certificate" from the words on it; and
// the audit trail shows the attachment was opened. Matching the certificate to a customer and sending it are added here as UW-5 and
// UW-8 land. It creates one workspace named "smoke-<time>" and leaves it (workspaces cannot be deleted through the API yet).
// Exit code 0 when every step passes, 1 otherwise.
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    key: { type: 'string' },
    'metrics-token': { type: 'string' },
    timeout: { type: 'string', default: '30000' },
  },
});
const url = (values.url ?? process.env.XO_SMOKE_URL ?? '').replace(/\/+$/, '');
const key = values.key ?? process.env.XO_SMOKE_KEY;
if (url === '' || key === undefined) {
  console.error('usage: node scripts/smoke-instance.mjs --url <instance url> --key <access key> [--metrics-token <token>]');
  process.exit(2);
}
const timeoutMs = Number(values.timeout);
let failures = 0;
const ok = (s) => console.log(`✔ ${s}`);
const bad = (s) => (failures++, console.log(`✘ ${s}`));

async function call(method, path, { body, headers = {}, base = api } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...headers },
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, text, json };
}

const CERTIFICATE =
  'Certificate of Insurance\n\nThis is to certify that Asha Rao holds policy P-9 with Example Mutual.\nValid from 1 April 2026 until 31 March 2027.\n';
function certificateEmail() {
  const b = 'smoke-boundary';
  return [
    'From: Asha Rao <asha@example.com>',
    'To: certificates@example.com',
    'Subject: My insurance certificate',
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello, my certificate is attached.',
    `--${b}`,
    'Content-Type: text/plain; name="certificate.txt"',
    'Content-Disposition: attachment; filename="certificate.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(CERTIFICATE).toString('base64'),
    `--${b}--`,
    '',
  ].join('\r\n');
}

let api = url;
try {
  const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  health.ok ? ok(`alive (${url}/health)`) : bad(`/health answered ${health.status}`);
  const readyz = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(timeoutMs) });
  const ready = await readyz.json().catch(() => ({}));
  readyz.ok ? ok(`ready (${(ready.checks ?? []).map((c) => c.name).join(', ')})`) : bad(`not ready: ${JSON.stringify(ready)}`);
  // An instance serving Studio has the API under /api; one serving only the API has it at the root.
  const probe = await fetch(`${url}/api/openapi.json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (probe.ok && (probe.headers.get('content-type') ?? '').includes('json')) {
    api = `${url}/api`;
    ok('Studio is served at /, the API under /api');
  } else ok('the API is served at the root (no Studio on this instance)');
  if (values['metrics-token'] !== undefined) {
    const m = await fetch(`${url}/metrics`, {
      headers: { authorization: `Bearer ${values['metrics-token']}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await m.text();
    m.ok && text.includes('xo_build_info') ? ok('metrics are exported') : bad(`/metrics answered ${m.status}`);
  }

  const ws = await call('POST', '/workspaces', {
    body: JSON.stringify({ name: `smoke-${new Date().toISOString()}` }),
    headers: { 'content-type': 'application/json' },
  });
  if (ws.status !== 201) throw new Error(`could not create a workspace (${ws.status}): ${ws.text.slice(0, 300)}`);
  const w = ws.json.workspaceId;
  ok(`workspace ${w} created`);

  const up = await call('POST', `/workspaces/${w}/sources?filename=certificate-email.eml`, {
    body: certificateEmail(),
    headers: { 'content-type': 'message/rfc822' },
  });
  if (up.status !== 201) throw new Error(`the email upload was refused (${up.status}): ${up.text.slice(0, 300)}`);
  const opened = (up.json.attachments ?? []).filter((a) => a.sourceId !== undefined && a.notOpened === undefined);
  opened.length === 1
    ? ok('the emailed certificate was opened as its own source')
    : bad(`expected 1 opened attachment, got ${JSON.stringify(up.json.attachments)}`);

  if (opened[0] !== undefined) {
    const compiled = await call('POST', `/workspaces/${w}/sources/${opened[0].sourceId}/compile`);
    const rec = compiled.json ?? {};
    rec.status === 'succeeded' ? ok('the certificate compiled') : bad(`compile ${compiled.status}: ${compiled.text.slice(0, 300)}`);
    const kind = rec.sourceReport?.kindProposals?.[0]?.kind;
    kind === 'certificate'
      ? ok('it was recognised as a certificate (proposed, for a person to confirm)')
      : bad(`the proposed kind was ${kind}`);
  }
  const audit = await call('GET', `/workspaces/${w}/audit/events?event=source.extracted`);
  (audit.json?.events ?? []).length >= 1
    ? ok('the audit trail records the attachment being opened')
    : bad(`no source.extracted audit event (${audit.status})`);
} catch (cause) {
  bad(cause instanceof Error ? cause.message : String(cause));
}
console.log(failures === 0 ? '\nsmoke test passed' : `\nsmoke test FAILED (${failures} step(s))`);
process.exit(failures === 0 ? 0 : 1);
