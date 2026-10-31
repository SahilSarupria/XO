/**
 * Runs inside the sandbox child process. It deliberately imports NOTHING but
 * Node built-ins statically: the parent grants this process read access to
 * exactly this file and the capability-layer's pure evaluator modules, and
 * nothing else. It has no API keys, no network (when launched under a network
 * namespace), no write access and no ability to spawn processes.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Msg {
  readonly id: number;
  readonly kind: 'eval' | 'probe' | 'spin';
  readonly tree?: unknown;
  readonly facts?: unknown;
}

// Defense in depth for hosts WITHOUT a network namespace (macOS, Windows, locked-down containers): make every network entry point
// throw. This is NOT isolation — code that can reach an unpatched primitive could still connect — which is why the parent reports
// the mode honestly ("guard", never "isolated") and why network isolation stays `required` by default. The evaluator itself has no I/O.
if (process.env['XO_SANDBOX_NET_GUARD'] === '1') {
  const deny = (): never => {
    const e = new Error('network access is blocked in the sandbox') as NodeJS.ErrnoException;
    e.code = 'XO_NET_GUARD';
    throw e;
  };
  // Builtin ESM namespaces are read-only; patch the shared CommonJS export objects, then re-sync the named ESM exports.
  const patch = async (name: string, keys: readonly string[]): Promise<void> => {
    const mod = ((await import(name)) as unknown as { default: Record<string, unknown> }).default;
    for (const k of keys) mod[k] = deny;
  };
  const net = ((await import('node:net')) as unknown as { default: { Socket: { prototype: Record<string, unknown> } } }).default;
  net.Socket.prototype['connect'] = deny;
  await patch('node:net', ['connect', 'createConnection']);
  await patch('node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']);
  await patch('node:dgram', ['createSocket']);
  await patch('node:http', ['request', 'get']);
  await patch('node:https', ['request', 'get']);
  (await import('node:module')).syncBuiltinESMExports();
  (globalThis as { fetch: unknown }).fetch = deny;
}

const distDir = process.argv[2] as string;
const testHooks = process.env['XO_SANDBOX_TEST_HOOKS'] === '1';
const { evaluateTree } = (await import(pathToFileURL(join(distDir, 'decision-tree.js')).href)) as {
  evaluateTree: (tree: unknown, facts: unknown) => unknown;
};
const fs = await import('node:fs');

function probe(): Record<string, string> {
  const out: Record<string, string> = {};
  const t = (name: string, f: () => unknown): void => {
    try {
      f();
      out[name] = 'ALLOWED';
    } catch (e) {
      out[name] = (e as { code?: string }).code ?? (e as Error).name;
    }
  };
  t('fs_write', () => fs.writeFileSync(join(process.cwd(), `.xo-sandbox-probe-${process.pid}`), 'x'));
  t('fs_read_outside', () => fs.readFileSync('/etc/hostname'));
  t('env_secrets', () => {
    const leaked = Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k));
    if (leaked.length > 0) throw Object.assign(new Error('leaked'), { code: `LEAKED:${leaked.join(',')}` });
  });
  t('code_gen', () => new Function('return 1')());
  return out;
}

process.on('message', async (m: Msg) => {
  try {
    if (m.kind === 'eval') process.send?.({ id: m.id, result: evaluateTree(m.tree, m.facts) });
    else if (m.kind === 'probe') {
      const r = probe();
      const cp = await import('node:child_process').then(
        (x) => {
          try {
            x.execSync('true');
            return 'ALLOWED';
          } catch (e) {
            return (e as { code?: string }).code ?? 'blocked';
          }
        },
        () => 'blocked',
      );
      const net = await import('node:net').then(
        (n) =>
          new Promise<string>((resolve) => {
            let c: ReturnType<typeof n.connect>;
            try {
              c = n.connect({ host: '1.1.1.1', port: 443 });
            } catch (e) {
              resolve(`BLOCKED(${(e as NodeJS.ErrnoException).code ?? 'error'})`);
              return;
            }
            const timer = setTimeout(() => {
              c.destroy();
              resolve('BLOCKED(timeout)');
            }, 1200);
            c.on('connect', () => {
              clearTimeout(timer);
              c.destroy();
              resolve('ALLOWED');
            });
            c.on('error', (e: NodeJS.ErrnoException) => {
              clearTimeout(timer);
              resolve(`BLOCKED(${e.code ?? 'error'})`);
            });
          }),
      );
      process.send?.({ id: m.id, result: { ...r, spawn: cp, net } });
    } else if (m.kind === 'spin' && testHooks) {
      for (;;) {
        /* test hook: burn CPU until killed */
      }
    }
  } catch (e) {
    process.send?.({ id: m.id, error: (e as Error).message });
  }
});
process.send?.({ ready: true });
