import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { settingSpec } from './settings.js';

/**
 * UW-17 (ADR 0023, rule 3) — where secrets come from. The instance asks a provider; today that is the environment or a local file
 * encrypted with AES-256-GCM, later a cloud secret manager implementing the same interface. The file's key never lives in the data
 * directory, so a copy of the data (a backup, a stolen disk image of that volume) is not a copy of the secrets.
 */
export interface SecretProvider {
  readonly kind: string;
  /** Every secret it holds, by setting name. */
  load(): Promise<Readonly<Record<string, string>>>;
}

export class SecretsError extends Error {}

const FORMAT = 'xo-secrets/1';
const KEY_BYTES = 32;

interface SecretsFile {
  readonly format: typeof FORMAT;
  readonly alg: 'aes-256-gcm';
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

/** Decodes a key given as base64 (the `XO_SECRETS_KEY` form). */
export function parseSecretsKey(base64: string): Buffer {
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== base64.trim()) {
    throw new SecretsError(`the secrets key must be ${KEY_BYTES} bytes, base64-encoded`);
  }
  return key;
}

async function assertOwnerOnly(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const s = await stat(path);
  if ((s.mode & 0o077) !== 0) {
    throw new SecretsError(`${path} is readable by other users (mode ${(s.mode & 0o777).toString(8)}); run: chmod 600 ${path}`);
  }
}

/** Reads the key file, or creates one (owner-only) when `create` is set and none exists. */
export async function loadOrCreateSecretsKey(keyFile: string, opts: { readonly create: boolean }): Promise<Buffer> {
  try {
    await assertOwnerOnly(keyFile);
    return parseSecretsKey((await readFile(keyFile, 'utf8')).trim());
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || !opts.create) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new SecretsError(`no secrets key at ${keyFile}`);
      throw cause;
    }
  }
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  await writeFile(keyFile, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

export class EnvSecretProvider implements SecretProvider {
  readonly kind = 'environment';
  constructor(private readonly env: Readonly<Record<string, string | undefined>>) {}
  async load(): Promise<Readonly<Record<string, string>>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) if (v !== undefined && settingSpec(k)?.secret === true) out[k] = v;
    return out;
  }
}

/** The local encrypted secrets file. Only names the registry marks as secret may be stored, so a typo cannot become a dead secret. */
export class EncryptedFileSecretStore implements SecretProvider {
  readonly kind = 'encrypted-file';
  constructor(
    private readonly file: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== KEY_BYTES) throw new SecretsError('the secrets key must be 32 bytes');
  }

  async load(): Promise<Readonly<Record<string, string>>> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw cause;
    }
    let parsed: SecretsFile;
    try {
      parsed = JSON.parse(raw) as SecretsFile;
    } catch {
      throw new SecretsError(`${this.file} is not a secrets file`);
    }
    if (parsed.format !== FORMAT || parsed.alg !== 'aes-256-gcm') throw new SecretsError(`${this.file}: unknown format`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parsed.iv, 'base64'));
      decipher.setAAD(Buffer.from(FORMAT));
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as Record<string, string>;
    } catch {
      throw new SecretsError(`${this.file} cannot be decrypted with this key (wrong key, or the file was altered)`);
    }
  }

  async names(): Promise<readonly string[]> {
    return Object.keys(await this.load()).sort();
  }

  async set(name: string, value: string): Promise<void> {
    if (settingSpec(name)?.secret !== true) throw new SecretsError(`${name} is not a secret setting (see docs/CONFIGURATION.md)`);
    if (value.length === 0 || /[\r\n\u0000]/.test(value)) throw new SecretsError('a secret must be one non-empty line');
    await this.write({ ...(await this.load()), [name]: value });
  }

  async remove(name: string): Promise<boolean> {
    const current = { ...(await this.load()) };
    if (current[name] === undefined) return false;
    delete current[name];
    await this.write(current);
    return true;
  }

  private async write(values: Readonly<Record<string, string>>): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(FORMAT));
    const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(values), 'utf8')), cipher.final()]);
    const body: SecretsFile = {
      format: FORMAT,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
