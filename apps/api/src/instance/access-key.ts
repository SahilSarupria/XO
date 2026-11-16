import { LocalFsBlobStore } from '@xo/storage';
import { FsApiKeyStore } from '../auth/fs-api-key-store.js';
import { issueApiKey } from '../auth/key-lifecycle.js';

/** UW-17 — issues an access key (used by `xo up` for the instance owner on first start). Only its hash is stored; the key is returned once. */
export async function issueAccessKey(
  apiKeysDir: string,
  input: { readonly identityId: string; readonly kind: 'human' | 'service'; readonly expiresInDays?: number },
): Promise<{ readonly rawKey: string; readonly expiresAt?: string }> {
  const issued = await issueApiKey(new FsApiKeyStore(new LocalFsBlobStore(apiKeysDir)), {
    identityId: input.identityId,
    kind: input.kind,
    ...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
  });
  if (!issued.ok) throw issued.error;
  return {
    rawKey: issued.value.rawKey,
    ...(issued.value.record.expiresAt !== undefined ? { expiresAt: issued.value.record.expiresAt } : {}),
  };
}
