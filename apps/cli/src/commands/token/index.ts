import { resolve } from 'node:path';
import { FileTokenStore, SCOPES, TokenFileError, type Scope } from '@xo/server';
import type { CommandRegistry } from '../../command-registry.js';

const SUBSYSTEM = 'server';
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => (process.stderr.write(`error: ${s}\n`), 1);
const str = (f: Readonly<Record<string, string | boolean>>, k: string): string | undefined =>
  typeof f[k] === 'string' ? (f[k] as string) : undefined;

/** `30d`, `12h`, `90m`; anything else is refused, because a typo here would silently mint a token that never expires or expires at once. */
export function parseDuration(s: string): number | undefined {
  const m = /^([1-9][0-9]{0,5})([mhd])$/.exec(s);
  if (m === null) return undefined;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

export function registerCommands(registry: CommandRegistry): void {
  registry.declareSubsystem(SUBSYSTEM, 'API access tokens: scoped, expiring, revocable (the file holds only hashes)');
  registry.register({
    name: 'token',
    subsystem: SUBSYSTEM,
    usage:
      'xo token create <client-id> --scopes read,run[,approve,lease,ledger-sync,admin] (--ttl 30d | --no-expiry) [--note <text>] [--tokens <file>]\n' +
      '                        Prints the token ONCE; only its hash is stored. Scopes: read, run, approve, lease, ledger-sync, admin (admin satisfies any).\n' +
      'xo token list [--tokens <file>] [--json]          Clients, scopes, expiry, revocation (never a token)\n' +
      'xo token revoke <client-id> [--tokens <file>]     Takes effect on a running server within about a second\n' +
      'xo token rotate <client-id> [--ttl 30d] [--overlap 1h] [--tokens <file>]   New token, same scopes; the old one stops after the overlap (default: at once)\n' +
      '                        The file defaults to $XO_TOKEN_FILE; it is created owner-only (0600) and refused if group/world accessible.',
    run: async (args) => {
      const [sub, id] = args.positionals;
      const path = str(args.flags, 'tokens') ?? process.env['XO_TOKEN_FILE'];
      if (sub === undefined || path === undefined)
        return fail('usage: xo token <create|list|revoke|rotate> ... --tokens <file> (or set XO_TOKEN_FILE)');
      try {
        const store = FileTokenStore.open(resolve(path));
        if (sub === 'list') {
          const rows = store.list();
          if (args.flags['json'] === true) out(JSON.stringify(rows, null, 2));
          else if (rows.length === 0) out('no clients');
          else
            for (const r of rows)
              out(
                `${r.id}  scopes=${r.scopes.join(',')}  created=${r.createdAt}  expires=${r.expiresAt ?? 'never'}${r.revokedAt !== undefined ? `  REVOKED=${r.revokedAt}` : ''}${r.note !== undefined ? `  # ${r.note}` : ''}`,
              );
          return 0;
        }
        if (id === undefined) return fail(`usage: xo token ${sub} <client-id>`);
        if (sub === 'revoke') {
          store.revoke(id);
          out(`revoked ${id}`);
          return 0;
        }
        const ttlFlag = str(args.flags, 'ttl');
        const ttl = ttlFlag === undefined ? undefined : parseDuration(ttlFlag);
        if (ttlFlag !== undefined && ttl === undefined) return fail('--ttl must look like 90m, 12h or 30d');
        if (sub === 'create') {
          const scopes = (str(args.flags, 'scopes') ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '');
          const bad = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
          if (scopes.length === 0 || bad.length > 0)
            return fail(`--scopes must be a non-empty list from ${SCOPES.join(', ')}${bad.length > 0 ? ` (not: ${bad.join(', ')})` : ''}`);
          if (ttl === undefined && args.flags['no-expiry'] !== true)
            return fail('give --ttl (for example 30d) or, deliberately, --no-expiry');
          const note = str(args.flags, 'note');
          const token = store.create(id, scopes as Scope[], {
            ...(ttl !== undefined ? { ttlMs: ttl } : {}),
            ...(note !== undefined ? { note } : {}),
          });
          out(`client ${id} created with scopes ${scopes.join(',')}${ttl !== undefined ? ` (expires in ${ttlFlag})` : ' (never expires)'}`);
          out('token (shown once; store it in your secret manager, it cannot be recovered):');
          out(token);
          return 0;
        }
        if (sub === 'rotate') {
          const overlapFlag = str(args.flags, 'overlap');
          const overlap = overlapFlag === undefined ? 0 : parseDuration(overlapFlag);
          if (overlap === undefined) return fail('--overlap must look like 15m or 1h');
          const r = store.rotate(id, { ...(ttl !== undefined ? { ttlMs: ttl } : {}), overlapMs: overlap });
          out(`rotated ${id} -> ${r.id}; the old token ${overlap === 0 ? 'stops working now' : `works for ${overlapFlag} more`}`);
          out('token (shown once):');
          out(r.token);
          return 0;
        }
        return fail(`unknown subcommand "${sub}"`);
      } catch (e) {
        return fail(e instanceof TokenFileError ? e.message : (e as Error).message);
      }
    },
  });
}
