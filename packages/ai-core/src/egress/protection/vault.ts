/**
 * UW-14d — reversible tokens. A token vault belongs to one workflow (its scope): the same real value always becomes the same
 * placeholder within it (`CLIENT_0001`), so a model can reason about "the same client" without seeing who it is.
 *
 * Coming back, model output is untrusted:
 *   - every placeholder-shaped string anywhere in the output must be one this vault issued, of the entity the field expects;
 *     an unknown or malformed placeholder rejects the WHOLE output (a model inventing `CLIENT_0007` or `CLIENT_1` is an error,
 *     never a guess);
 *   - values are put back only into fields the caller declared, of the declared entity, after that check;
 *   - fields the caller declares FORBIDDEN (recipients, attachments, amounts) may not be filled from model output at all: those
 *     always come from structured, resolved data (UAC-26).
 *
 * The vault is sealed at rest by the host (AES-256-GCM; see `sealVault`) and erased with its workflow; it is the crown-jewel store
 * of the boundary, so it never leaves the instance and is never logged.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { PROTECTED_ENTITIES } from './scanner.js';

export const PLACEHOLDER = /\b([A-Z][A-Z0-9]{1,30})_(\d{4,6})\b/g;
const ENTITY = /^[A-Z][A-Z0-9]{1,30}$/;

export class TokenVaultError extends Error {
  constructor(
    readonly code: 'unknown_placeholder' | 'wrong_entity' | 'forbidden_field' | 'malformed' | 'full' | 'tampered',
    message: string,
  ) {
    super(message);
  }
}

interface VaultData {
  readonly schema: 'xo.token-vault/1';
  readonly scope: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** placeholder → real value */
  readonly entries: Record<string, { readonly entity: string; readonly value: string; readonly key: string }>;
  readonly counters: Record<string, number>;
}

export type FieldSpec =
  /** A placeholder of this entity is replaced by its real value; anything else that is not plain text is refused. */
  | { readonly kind: 'entity'; readonly entity: string }
  /** Free text: placeholders stay placeholders (but must still be ones this vault issued). */
  | { readonly kind: 'text' }
  /** Never from model output (recipients, attachments, amounts). Any value here rejects the output. */
  | { readonly kind: 'forbidden'; readonly reason: string };

export class TokenVault {
  private readonly data: VaultData;
  private readonly byValue = new Map<string, string>();

  private constructor(data: VaultData) {
    this.data = data;
    for (const [ph, e] of Object.entries(data.entries)) this.byValue.set(e.key, ph);
  }

  static create(scope: string, now: Date, retentionDays: number): TokenVault {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(scope)) throw new TokenVaultError('malformed', 'a vault scope is an id');
    return new TokenVault({
      schema: 'xo.token-vault/1',
      scope,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + retentionDays * 86_400_000).toISOString(),
      entries: {},
      counters: {},
    });
  }

  get scope(): string {
    return this.data.scope;
  }
  get expiresAt(): string {
    return this.data.expiresAt;
  }
  get size(): number {
    return Object.keys(this.data.entries).length;
  }

  /**
   * The placeholder for a real value (the same one every time). `key` groups forms of one value (the dictionary's hash, so "Ravi
   * Kumar", "R Kumar" and "Kumar Ravi" are one CLIENT_0001); the first form seen is the one put back.
   */
  tokenize(value: string, entity: string, key?: string): string {
    if (!ENTITY.test(entity)) throw new TokenVaultError('malformed', `"${entity.slice(0, 32)}" is not an entity name`);
    const k = `${entity}\u0000${key ?? value}`;
    const have = this.byValue.get(k);
    if (have !== undefined) return have;
    return this.issue(value, entity, k);
  }

  private issue(value: string, entity: string, key: string): string {
    const n = (this.data.counters[entity] ?? 0) + 1;
    if (n > 999_999) throw new TokenVaultError('full', `the vault has no more ${entity} placeholders`);
    this.data.counters[entity] = n;
    const ph = `${entity}_${String(n).padStart(4, '0')}`;
    this.data.entries[ph] = { entity, value, key };
    this.byValue.set(key, ph);
    return ph;
  }

  /** The real value of a placeholder this vault issued, or undefined. */
  resolve(placeholder: string): { readonly entity: string; readonly value: string } | undefined {
    if (!Object.prototype.hasOwnProperty.call(this.data.entries, placeholder)) return undefined;
    const e = this.data.entries[placeholder]!;
    return { entity: e.entity, value: e.value };
  }

  /** An entity whose placeholders this boundary issues: this vault's, and every detector's. `ISO_9001` is just text. */
  private inPlay(entity: string): boolean {
    return PROTECTED_ENTITIES.has(entity) || Object.prototype.hasOwnProperty.call(this.data.counters, entity);
  }

  /** Every placeholder-shaped string in `text` must be one this vault issued. */
  checkText(text: string, where: string): void {
    for (const m of text.matchAll(PLACEHOLDER)) {
      if (this.inPlay(m[1]!) && this.resolve(m[0]) === undefined)
        throw new TokenVaultError('unknown_placeholder', `${where}: "${m[0]}" is not a placeholder this workflow issued`);
    }
    // Near-misses a model produces when it mangles a placeholder: `CLIENT_1`, `CLIENT-0001`, `client_0001`.
    for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9]{1,30})[_-](\d{1,8})\b/g)) {
      if (m[0] === m[0].toUpperCase() && /^[A-Z0-9]+_\d{4,6}$/.test(m[0])) continue;
      if (this.inPlay(m[1]!.toUpperCase())) throw new TokenVaultError('malformed', `${where}: "${m[0]}" looks like a mangled placeholder`);
    }
  }

  /**
   * Puts real values back into `output` (parsed model output) where `fields` allow, after checking every string in it. Returns a
   * new object; the input is not changed. Throws on anything doubtful, and the caller must then discard the whole output.
   */
  reidentify<T>(output: T, fields: Readonly<Record<string, FieldSpec>>): T {
    const walk = (v: unknown, path: string): unknown => {
      const spec = fields[path];
      if (spec?.kind === 'forbidden') {
        if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === ''))
          throw new TokenVaultError('forbidden_field', `${path} may not come from model output (${spec.reason})`);
        return v;
      }
      if (typeof v === 'string') {
        this.checkText(v, path);
        if (spec?.kind === 'entity') {
          const trimmed = v.trim();
          if (trimmed === '') return v;
          const hit = this.resolve(trimmed);
          if (hit === undefined) throw new TokenVaultError('unknown_placeholder', `${path}: expected a ${spec.entity} placeholder`);
          if (hit.entity !== spec.entity) throw new TokenVaultError('wrong_entity', `${path}: expected ${spec.entity}, got ${hit.entity}`);
          return hit.value;
        }
        return v;
      }
      if (Array.isArray(v)) return v.map((x) => walk(x, `${path}[]`));
      if (v !== null && typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) {
          this.checkText(k, `${path}.${k}`);
          o[k] = walk(x, path === '' ? k : `${path}.${k}`);
        }
        return o;
      }
      return v;
    };
    // Forbidden fields absent from the output are fine; present anywhere (any path), they are checked by walk.
    return walk(output, '') as T;
  }

  toJSON(): never {
    throw new TokenVaultError('malformed', 'a token vault is never serialised in the clear; use sealVault');
  }

  /** @internal for sealing */
  rawData(): VaultData {
    return this.data;
  }

  /** @internal for unsealing */
  static fromData(d: VaultData): TokenVault {
    if (d.schema !== 'xo.token-vault/1') throw new TokenVaultError('tampered', 'not a token vault');
    return new TokenVault(d);
  }
}

/** The key a workspace's vaults are sealed under. */
export function vaultKey(masterKey: Uint8Array, workspaceId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.from('xo-token-vault/1'), Buffer.from(workspaceId, 'utf8'), 32));
}

export function sealVault(key: Buffer, vault: TokenVault): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`xo.token-vault/1\u0000${vault.scope}`));
  const data = Buffer.concat([c.update(JSON.stringify(vault.rawData()), 'utf8'), c.final()]);
  return JSON.stringify({
    scope: vault.scope,
    expiresAt: vault.expiresAt,
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

export function unsealVault(key: Buffer, sealed: string): TokenVault {
  try {
    const box = JSON.parse(sealed) as { scope: string; iv: string; tag: string; data: string };
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAAD(Buffer.from(`xo.token-vault/1\u0000${box.scope}`));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    const data = JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8')) as VaultData;
    if (data.scope !== box.scope) throw new Error('scope');
    return TokenVault.fromData(data);
  } catch (e) {
    if (e instanceof TokenVaultError) throw e;
    throw new TokenVaultError('tampered', 'the token vault does not open (wrong workspace, wrong key, or altered)');
  }
}
