#!/usr/bin/env node
/**
 * OIDC identity bindings: provision, revoke, list. Deliberately NOT an HTTP
 * route, for the same bootstrap reason `manage-keys.ts` is not (see that
 * file): an endpoint that creates bindings would need its own authentication,
 * and an open one would let any identity-provider user grant themselves
 * access. Whoever can run this has filesystem access to the bindings
 * directory — the same trust level as starting the server.
 *
 * A binding maps a verified `(issuer, subject)` to an XO principal (kind, stable
 * id, optional org label). It is the ONLY way an OIDC token becomes an XO
 * caller. It grants no permission; authorization remains `@xo/permissions`.
 *
 * Usage:
 *   node --import tsx scripts/manage-oidc-bindings.ts bind   --issuer <iss> --subject <sub> --identity <principalId> --kind <human|service> [--org <orgId>] [--dir <dir>]
 *   node --import tsx scripts/manage-oidc-bindings.ts revoke --issuer <iss> --subject <sub> [--dir <dir>]
 *   node --import tsx scripts/manage-oidc-bindings.ts list   [--dir <dir>]
 *
 * `--dir` defaults to `XO_API_OIDC_BINDINGS_DIR`, else `.xo-data/oidc-bindings`
 * (the server's default) — pass the directory the running server uses.
 * `--issuer` must equal the server's `XO_API_OIDC_ISSUER` exactly.
 */
import { LocalFsBlobStore } from '@xo/storage';
import { parsePrincipal } from '@xo/permissions';
import { FsIdentityBindingStore, computeBindingId } from '../src/auth/oidc/fs-binding-store.js';

function parseFlags(args: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined || !arg.startsWith('--')) throw new Error(`unexpected argument "${arg ?? ''}"`);
    const value = args[i + 1];
    if (value === undefined) throw new Error(`flag ${arg} requires a value`);
    flags[arg.slice(2)] = value;
    i++;
  }
  return flags;
}

function openStore(flags: Record<string, string>): FsIdentityBindingStore {
  return new FsIdentityBindingStore(
    new LocalFsBlobStore(flags['dir'] ?? process.env['XO_API_OIDC_BINDINGS_DIR'] ?? '.xo-data/oidc-bindings'),
  );
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let flags: Record<string, string>;
  try {
    flags = parseFlags(rest);
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : 'bad arguments');
  }
  const store = openStore(flags);

  if (command === 'bind') {
    const { issuer, subject, identity, kind, org } = flags;
    if (issuer === undefined || subject === undefined || identity === undefined)
      return fail('bind requires --issuer, --subject and --identity (and --kind human|service)');
    const principal = parsePrincipal({ kind, id: identity, ...(org !== undefined ? { orgId: org } : {}) });
    if (!principal.ok) return fail(`failed to bind: ${principal.error.message} (pass --kind human|service)`);
    const created = await store.create({
      bindingId: computeBindingId(issuer, subject),
      issuer,
      subject,
      principalKind: principal.value.kind,
      identityId: principal.value.id,
      ...(principal.value.orgId !== undefined ? { orgId: principal.value.orgId } : {}),
      createdAt: new Date().toISOString(),
    });
    if (!created.ok) return fail(`failed to bind: ${created.error.message}`);
    console.log(
      `Bound (${issuer}, ${subject}) -> ${principal.value.kind} principal "${principal.value.id}"${principal.value.orgId !== undefined ? ` (org label "${principal.value.orgId}")` : ''}.`,
    );
    console.log('This grants no permission by itself; authorization is decided separately.');
    return;
  }
  if (command === 'revoke') {
    const { issuer, subject } = flags;
    if (issuer === undefined || subject === undefined) return fail('revoke requires --issuer and --subject');
    const revoked = await store.revoke(issuer, subject);
    if (!revoked.ok) return fail(`failed to revoke: ${revoked.error.message}`);
    console.log(
      revoked.value.alreadyRevoked
        ? 'Binding was already revoked.'
        : 'Binding revoked. Existing access tokens stop working on their next request.',
    );
    return;
  }
  if (command === 'list') {
    const listed = await store.list();
    if (!listed.ok) return fail(`failed to list: ${listed.error.message}`);
    for (const r of listed.value) {
      console.log(
        `${r.revokedAt === undefined ? 'active ' : 'revoked'}  ${r.issuer}  ${r.subject}  ->  ${r.principalKind}:${r.identityId}${r.orgId !== undefined ? `  org=${r.orgId}` : ''}`,
      );
    }
    if (listed.value.length === 0) console.log('(no bindings)');
    return;
  }

  console.error('Usage:');
  console.error(
    '  manage-oidc-bindings.ts bind   --issuer <iss> --subject <sub> --identity <principalId> --kind <human|service> [--org <orgId>] [--dir <dir>]',
  );
  console.error('  manage-oidc-bindings.ts revoke --issuer <iss> --subject <sub> [--dir <dir>]');
  console.error('  manage-oidc-bindings.ts list   [--dir <dir>]');
  process.exitCode = 1;
}

await main();
