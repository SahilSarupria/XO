import { createHash } from 'node:crypto';
import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
import type { IdentityBinding, IdentityBindingStore } from './binding-store.interface.js';

const PREFIX = 'identity-bindings/by-subject/';

/** Hash of the JSON pair, so (issuer, subject) boundaries are unambiguous and no subject text becomes a path. */
export function computeBindingId(issuer: string, subject: string): string {
  return createHash('sha256')
    .update(JSON.stringify([issuer, subject]))
    .digest('hex');
}

function recordKey(issuer: string, subject: string): string {
  return `${PREFIX}${computeBindingId(issuer, subject)}.json`;
}

function decode(bytes: Uint8Array, issuer: string, subject: string): IdentityBinding | undefined {
  try {
    const record = JSON.parse(new TextDecoder().decode(bytes)) as IdentityBinding;
    // Defence in depth: the stored pair must be exactly the pair asked for.
    if (record.issuer !== issuer || record.subject !== subject || record.bindingId !== computeBindingId(issuer, subject)) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

export class FsIdentityBindingStore implements IdentityBindingStore {
  constructor(private readonly store: BlobStore) {}

  async create(binding: IdentityBinding): Promise<Result<void, XoError>> {
    const found = await this.find(binding.issuer, binding.subject);
    if (!found.ok) return err(found.error);
    if (found.value !== undefined && found.value.revokedAt === undefined) {
      return err(new XoError(ErrorCode.ALREADY_EXISTS, 'an active binding already exists for this identity'));
    }
    const put = await this.store.put(recordKey(binding.issuer, binding.subject), JSON.stringify(binding));
    if (!put.ok) return err(put.error);
    return ok(undefined);
  }

  async find(issuer: string, subject: string): Promise<Result<IdentityBinding | undefined, XoError>> {
    const raw = await this.store.get(recordKey(issuer, subject));
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return ok(undefined);
      return err(raw.error);
    }
    return ok(decode(raw.value, issuer, subject));
  }

  async revoke(issuer: string, subject: string): Promise<Result<{ readonly alreadyRevoked: boolean }, XoError>> {
    const found = await this.find(issuer, subject);
    if (!found.ok) return err(found.error);
    if (found.value === undefined) return err(new NotFoundError('identity binding'));
    if (found.value.revokedAt !== undefined) return ok({ alreadyRevoked: true });
    const updated: IdentityBinding = { ...found.value, revokedAt: new Date().toISOString() };
    const put = await this.store.put(recordKey(issuer, subject), JSON.stringify(updated));
    if (!put.ok) return err(put.error);
    return ok({ alreadyRevoked: false });
  }

  async list(): Promise<Result<readonly IdentityBinding[], XoError>> {
    const listed = await this.store.list(PREFIX);
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return ok([]);
      return err(listed.error);
    }
    const out: IdentityBinding[] = [];
    for (const key of listed.value) {
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      try {
        const record = JSON.parse(new TextDecoder().decode(raw.value)) as IdentityBinding;
        if (record.bindingId === computeBindingId(record.issuer, record.subject)) out.push(record);
      } catch {
        // corrupt record: omitted from the listing and never honoured by find()
      }
    }
    return ok(out);
  }
}
