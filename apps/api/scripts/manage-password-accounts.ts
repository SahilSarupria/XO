#!/usr/bin/env node
/**
 * Password accounts: create, issue a reset token, disable, enable, list. Deliberately NOT an HTTP route, for the same
 * bootstrap reason `manage-oidc-bindings.ts` is not: an endpoint that creates accounts or recovery tokens would need
 * its own authentication, and an open one would let anyone grant themselves access. Whoever can run this has
 * filesystem access to the accounts and bindings directories — the same trust level as starting the server.
 *
 * There is NO self-registration and NO self-service "forgot password". Recovery means an operator runs `reset` and
 * hands the printed single-use token to the person out of band. An operator who can issue tokens can therefore take
 * over any password account; every issuance is written to the auth audit log.
 *
 * This script never accepts, prints or stores a password: the person sets their own through the setup token.
 *
 * Usage:
 *   node --import tsx scripts/manage-password-accounts.ts create  --login <name> --identity <principalId> [--org <orgId>] [--operator <label>]
 *   node --import tsx scripts/manage-password-accounts.ts reset   --login <name> [--operator <label>]
 *   node --import tsx scripts/manage-password-accounts.ts disable --login <name> [--operator <label>]
 *   node --import tsx scripts/manage-password-accounts.ts enable  --login <name> [--operator <label>]
 *   node --import tsx scripts/manage-password-accounts.ts list
 *
 * Directories come from the same environment the server uses: XO_API_ACCOUNTS_DIR (default .xo-data/accounts),
 * XO_API_SESSIONS_DIR and XO_API_OIDC_BINDINGS_DIR. Point them at the directories the running server uses.
 */
import { loadPasswordAuthConfig } from '../src/auth/password/config.js';
import { createPasswordOnlySessionStores, createPasswordService, createPasswordStores } from '../src/auth/password/bundle.js';

function parseFlags(args: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined || !arg.startsWith('--')) throw new Error(`unexpected argument "${arg ?? ''}"`);
    if (arg === '--password') throw new Error('this tool never takes a password; the person sets their own with the setup token');
    const value = args[i + 1];
    if (value === undefined) throw new Error(`flag ${arg} requires a value`);
    flags[arg.slice(2)] = value;
    i++;
  }
  return flags;
}

const show = (v: string): string => JSON.stringify(v);
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
  const config = loadPasswordAuthConfig({ ...process.env, XO_API_PASSWORD_AUTH: '1' });
  if (config === undefined) return fail('password configuration could not be loaded');
  const stores = createPasswordStores(config);
  const { service } = createPasswordService(stores, createPasswordOnlySessionStores(config));
  const operator = flags['operator'] ?? 'operator:cli';

  try {
    if (command === 'create') {
      const { login, identity, org } = flags;
      if (login === undefined || identity === undefined) return fail('create requires --login and --identity');
      const created = await service.createAccount({
        loginName: login,
        identityId: identity,
        ...(org !== undefined ? { orgId: org } : {}),
        operator,
      });
      console.log(`Account created for ${show(created.loginName)} (${created.accountId}), bound to principal ${show(identity)}.`);
      console.log('');
      console.log(`  SETUP CODE (shown once, expires ${created.setupTokenExpiresAt}):`);
      console.log(`  ${created.setupToken}`);
      console.log('');
      console.log('Give it to the person out of band. They set their own password with it; you never see or choose it.');
      console.log('If they lose it, run `reset`. Recovery is operator-assisted: there is no self-service "forgot password".');
      return;
    }
    if (command === 'reset') {
      if (flags['login'] === undefined) return fail('reset requires --login');
      const issued = await service.issueResetToken(flags['login'], operator);
      console.log(`${issued.purpose === 'setup' ? 'SETUP' : 'RESET'} CODE (shown once, expires ${issued.expiresAt}):`);
      console.log(issued.token);
      console.log('Nothing changes until the person redeems it. Redeeming ends every existing session of the account.');
      return;
    }
    if (command === 'disable' || command === 'enable') {
      if (flags['login'] === undefined) return fail(`${command} requires --login`);
      const updated = await service.setAccountState(flags['login'], command === 'disable' ? 'disabled' : 'active', operator);
      console.log(
        command === 'disable'
          ? `Account ${show(updated.loginName)} disabled. Its sessions stop working on their next request.`
          : `Account ${show(updated.loginName)} enabled. Sessions from before it was disabled stay dead; the person signs in again.`,
      );
      return;
    }
    if (command === 'list') {
      const accounts = await stores.accounts.list();
      for (const a of accounts) {
        const pending = await stores.tokens.hasOutstanding(a.accountId);
        console.log(
          `${a.state.padEnd(8)} ${a.accountId}  ${show(a.loginName)}  password=${a.hash === undefined ? 'not set' : 'set'}${pending ? '  code outstanding' : ''}`,
        );
      }
      if (accounts.length === 0) console.log('(no password accounts)');
      return;
    }
  } catch (cause) {
    return fail(`failed: ${cause instanceof Error ? cause.message : 'unknown error'}`);
  }

  console.error('Usage:');
  console.error('  manage-password-accounts.ts create  --login <name> --identity <principalId> [--org <orgId>] [--operator <label>]');
  console.error('  manage-password-accounts.ts reset   --login <name> [--operator <label>]');
  console.error('  manage-password-accounts.ts disable --login <name> [--operator <label>]');
  console.error('  manage-password-accounts.ts enable  --login <name> [--operator <label>]');
  console.error('  manage-password-accounts.ts list');
  process.exitCode = 1;
}

void main();
