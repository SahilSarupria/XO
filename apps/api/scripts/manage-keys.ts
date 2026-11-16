#!/usr/bin/env node
/**
 * Key issuance/revocation, deliberately NOT an HTTP route.
 *
 * Why a script instead of `POST /admin/keys`: an admin route that mints
 * new API keys has to itself be reachable to bootstrap the very first
 * key — before any key exists, there's nothing to authenticate that
 * request with. Two ways out of that: (a) exempt `/admin/keys` from the
 * auth middleware, which means anyone who can reach the server at all
 * can mint themselves a valid key — that doesn't just weaken auth, it
 * makes the whole scheme pointless, since the "protected" surface has an
 * unprotected door into it; or (b) gate it behind some *other* secret
 * (a bootstrap token, mTLS, ...) — which is a second auth scheme this
 * task was explicitly scoped not to build. Operating directly on the
 * `ApiKeyStore` from a script run by whoever already has filesystem/
 * deploy access to `API_KEYS_DIR` sidesteps the bootstrap problem
 * entirely: that person already has the trust level needed to configure
 * and start the server in the first place, so handing them a script
 * that writes directly into the same store is not a new trust boundary,
 * just a convenient one. This mirrors how `apps/cli`'s commands operate
 * directly on local registry/store directories rather than going
 * through the HTTP layer.
 *
 * Usage:
 *   node --import tsx scripts/manage-keys.ts issue <identityId> --kind <human|service> [--org <orgId>] [--creator-did <did>] [--expires-in-days <n>] [--dir <dir>]
 *   node --import tsx scripts/manage-keys.ts rotate <identityId> --kind <human|service> [--org <orgId>] [--creator-did <did>] [--expires-in-days <n>] [--dir <dir>]
 *   node --import tsx scripts/manage-keys.ts revoke <identityId> [--dir <dir>]
 *
 * UW-1: every issued key expires (default 90 days, `--expires-in-days` 1-3650). `rotate` issues a new key and then revokes the
 * identity's other active keys, in that order, so a failure never locks the identity out.
 *
 * `--dir` defaults to `API_KEYS_DIR` if set, else `.xo-data/api-keys`
 * (same default `config.ts#loadConfig` uses) — pass the same directory
 * the running server was started with, or issued keys won't be visible
 * to it.
 */
import { LocalFsBlobStore } from '@xo/storage';
import { FsApiKeyStore } from '../src/auth/fs-api-key-store.js';
import { issueApiKey, rotateApiKeys, type IssueKeyInput } from '../src/auth/key-lifecycle.js';

function parseFlags(args: readonly string[]): { readonly positionals: string[]; readonly flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error(`flag --${name} requires a value`);
      }
      flags[name] = value;
      i++;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function resolveDir(flags: Record<string, string>): string {
  return flags['dir'] ?? process.env['API_KEYS_DIR'] ?? '.xo-data/api-keys';
}

function keyInput(identityId: string, flags: Record<string, string>): IssueKeyInput {
  // P1.0 M1: a key is bound to a principal at issuance, by the operator. There is no default kind.
  const days = flags['expires-in-days'];
  return {
    identityId,
    kind: flags['kind'],
    ...(flags['org'] !== undefined ? { orgId: flags['org'] } : {}),
    ...(flags['creator-did'] !== undefined ? { creatorDid: flags['creator-did'] } : {}),
    ...(days !== undefined ? { expiresInDays: Number(days) } : {}),
  };
}

function printKey(identityId: string, rawKey: string, expiresAt: string | undefined): void {
  // Printed exactly once, here, and never again — only the hash is ever persisted.
  console.log(`Issued API key for identity "${identityId}" (expires ${expiresAt ?? 'never'}):`);
  console.log(rawKey);
  console.log('\nStore this now — it will not be shown again.');
}

async function issue(identityId: string, flags: Record<string, string>): Promise<void> {
  const store = new FsApiKeyStore(new LocalFsBlobStore(resolveDir(flags)));
  const result = await issueApiKey(store, keyInput(identityId, flags));
  if (!result.ok) {
    console.error(`failed to issue key: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  printKey(identityId, result.value.rawKey, result.value.record.expiresAt);
}

async function rotate(identityId: string, flags: Record<string, string>): Promise<void> {
  const store = new FsApiKeyStore(new LocalFsBlobStore(resolveDir(flags)));
  const result = await rotateApiKeys(store, keyInput(identityId, flags));
  if (!result.ok) {
    console.error(`failed to rotate keys for "${identityId}": ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  printKey(identityId, result.value.rawKey, result.value.record.expiresAt);
  console.log(`Revoked ${result.value.revokedKeyHashes.length} previous key(s): ${result.value.revokedKeyHashes.join(', ') || 'none'}`);
}

async function revoke(identityId: string, flags: Record<string, string>): Promise<void> {
  const store = new FsApiKeyStore(new LocalFsBlobStore(resolveDir(flags)));
  const result = await store.revokeByIdentity(identityId);
  if (!result.ok) {
    console.error(`failed to revoke key(s) for "${identityId}": ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Revoked ${result.value.revokedCount} active key(s) for identity "${identityId}".`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseFlags(rest);
  const identityId = positionals[0];

  if (command === 'issue' && identityId !== undefined) {
    await issue(identityId, flags);
    return;
  }
  if (command === 'rotate' && identityId !== undefined) {
    await rotate(identityId, flags);
    return;
  }
  if (command === 'revoke' && identityId !== undefined) {
    await revoke(identityId, flags);
    return;
  }

  console.error('Usage:');
  console.error(
    '  manage-keys.ts issue <identityId> --kind <human|service> [--org <orgId>] [--creator-did <did>] [--expires-in-days <n>] [--dir <dir>]',
  );
  console.error(
    '  manage-keys.ts rotate <identityId> --kind <human|service> [--org <orgId>] [--creator-did <did>] [--expires-in-days <n>] [--dir <dir>]',
  );
  console.error('  manage-keys.ts revoke <identityId> [--dir <dir>]');
  process.exitCode = 1;
}

await main();
