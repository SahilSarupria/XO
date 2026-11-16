/**
 * ADR 0031 — the key the platform signs approval decisions with, on behalf of the authenticated reviewer.
 *
 * The signing key is durable and governed, never per process:
 *   - production: `XO_APPROVAL_SIGNING_KEY` (an Ed25519 PKCS#8 key, base64), a secret held by the operator's secret store
 *     and shared by every API instance; rotating it is setting a new value and restarting;
 *   - development: generated once, written owner-only to `<data>/approval-keys/generated.key`, and reused after restarts.
 * Every public key ever active is kept in the keyring (`<data>/approval-keys/<keyId>.pub.pem`, write-once, named by the
 * SHA-256 of the key), so a decision signed before a rotation or a restart still verifies, on any instance.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify as edVerify, type KeyObject } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '@xo/workflow-ir';

export interface ApprovalSigningKey {
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly source: 'configured' | 'generated';
}

export interface ApprovalKeyring {
  readonly active: ApprovalSigningKey;
  /** Every public key ever active here, by key id. */
  readonly publicKeys: ReadonlyMap<string, string>;
}

const keyIdOf = (pub: KeyObject): string =>
  createHash('sha256')
    .update(pub.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 32);

function fromPrivate(key: KeyObject, source: ApprovalSigningKey['source']): ApprovalSigningKey {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the approval signing key must be an Ed25519 key');
  const pub = createPublicKey(key);
  return {
    keyId: keyIdOf(pub),
    privateKeyPem: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    source,
  };
}

/** Parses `XO_APPROVAL_SIGNING_KEY` (base64 PKCS#8 DER, or a PEM). Throws a message that names the setting, never the key. */
export function parseApprovalSigningKey(text: string): ApprovalSigningKey {
  try {
    const t = text.trim();
    const key = t.startsWith('-----BEGIN')
      ? createPrivateKey(t)
      : createPrivateKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'pkcs8' });
    return fromPrivate(key, 'configured');
  } catch (cause) {
    void cause; // never echo key material
    throw new Error('XO_APPROVAL_SIGNING_KEY is not an Ed25519 private key (PKCS#8 DER, base64)');
  }
}

async function generatedKey(dir: string): Promise<ApprovalSigningKey> {
  const file = join(dir, 'generated.key');
  try {
    const h = await open(file, 'wx', 0o600);
    const { privateKey } = generateKeyPairSync('ed25519');
    await h.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await h.close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // another instance (or an earlier start) created it: use that one
  }
  for (let i = 0; i < 50; i++) {
    const pem = await readFile(file, 'utf8');
    if (pem.includes('END PRIVATE KEY')) return fromPrivate(createPrivateKey(pem), 'generated');
    await new Promise((r) => setTimeout(r, 20)); // the creator is still writing
  }
  throw new Error(`${file} is not a complete private key`);
}

async function rememberPublicKey(dir: string, key: ApprovalSigningKey): Promise<void> {
  const file = join(dir, `${key.keyId}.pub.pem`);
  try {
    await writeFile(file, key.publicKeyPem, { flag: 'wx', mode: 0o644 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // write-once: an existing entry must be this key
    if ((await readFile(file, 'utf8')) !== key.publicKeyPem) throw new Error(`approval keyring entry ${key.keyId} does not match its key`);
  }
}

async function readKeyring(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.pub.pem')).sort()) {
    const pem = await readFile(join(dir, name), 'utf8');
    const id = name.slice(0, -'.pub.pem'.length);
    if (keyIdOf(createPublicKey(pem)) !== id) throw new Error(`approval keyring entry ${name} does not match its name`);
    out.set(id, pem);
  }
  return out;
}

const cache = new Map<string, Promise<ApprovalKeyring>>();

/** The instance's approval keyring (cached per data directory and configured key). */
export function approvalKeyring(dataRootDir: string, env: Readonly<Record<string, string | undefined>>): Promise<ApprovalKeyring> {
  const configured = (env['XO_APPROVAL_SIGNING_KEY'] ?? '').trim();
  const production = env['NODE_ENV'] === 'production' || env['XO_ENV'] === 'production';
  const cacheKey = `${dataRootDir}\u0000${configured}`;
  let k = cache.get(cacheKey);
  if (k === undefined) {
    k = (async () => {
      if (configured === '' && production)
        throw new Error('XO_APPROVAL_SIGNING_KEY is required in production (a governed secret, shared by every instance)');
      const dir = join(dataRootDir, 'approval-keys');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => undefined);
      const active = configured !== '' ? parseApprovalSigningKey(configured) : await generatedKey(dir);
      await rememberPublicKey(dir, active);
      return { active, publicKeys: await readKeyring(dir) };
    })();
    k.catch(() => cache.delete(cacheKey));
    cache.set(cacheKey, k);
  }
  return k;
}

/** Re-reads the keyring (keys another instance or an earlier rotation added). */
export async function currentPublicKeys(dataRootDir: string): Promise<ReadonlyMap<string, string>> {
  return readKeyring(join(dataRootDir, 'approval-keys'));
}

/** Which keyring key verifies this journaled decision, or `undefined` when none does. */
export function verifyJournaledDecision(
  payload: Readonly<Record<string, unknown>>,
  signatureBase64: string,
  keys: ReadonlyMap<string, string>,
): string | undefined {
  for (const [keyId, pem] of keys) {
    try {
      if (edVerify(null, Buffer.from(canonicalJson(payload)), createPublicKey(pem), Buffer.from(signatureBase64, 'base64'))) return keyId;
    } catch {
      // a malformed signature verifies under no key
    }
  }
  return undefined;
}
