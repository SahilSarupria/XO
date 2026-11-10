import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry } from '../src/command-registry.js';
import { registerCommands } from '../src/commands/flow/index.js';
import { withTempDir } from './helpers.js';

async function flow(positionals: string[], flags: Record<string, string | boolean>): Promise<{ code: number; text: string; err: string }> {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const out: string[] = [];
  const err: string[] = [];
  const rO = process.stdout.write.bind(process.stdout);
  const rE = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (err.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await registry.get('flow')!.run({ positionals, flags } as never);
    return { code: Number(code), text: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = rO;
    process.stderr.write = rE;
  }
}

test('link-artifacts: identical items overlap, differing ones need a precedence order or are blocked (exit 2, nothing written, safety warned)', async () => {
  await withTempDir('xo-link-art-', async (tmp) => {
    const a = join(tmp, 'a.json');
    const b = join(tmp, 'b.json');
    const out = join(tmp, 'merged.json');
    writeFileSync(
      a,
      JSON.stringify([
        { id: 's1', rule: 'no wires over 10k' },
        { id: 's2', rule: 'log all' },
      ]),
    );
    writeFileSync(
      b,
      JSON.stringify({
        items: [
          { id: 's2', rule: 'log all' },
          { id: 's1', rule: 'no wires over 50k' },
        ],
      }),
    );
    const blocked = await flow(['link-artifacts', a, b], { kind: 'safety', names: 'a,b', out });
    assert.equal(blocked.code, 2);
    assert.match(blocked.err, /Do NOT run the linked set/);
    assert.throws(() => readFileSync(out));
    assert.deepEqual((JSON.parse(blocked.text) as { blocked: string[] }).blocked, ['s1']);
    const ok = await flow(['link-artifacts', a, b], { kind: 'safety', names: 'a,b', order: 'a,b', out });
    assert.equal(ok.code, 0, ok.err);
    const merged = JSON.parse(readFileSync(out, 'utf8')) as { id: string; rule: string }[];
    assert.equal(merged.find((m) => m.id === 's1')?.rule, 'no wires over 10k');
    assert.equal(merged.length, 2);
    assert.equal((await flow(['link-artifacts', a, b], { kind: 'nope' })).code, 1);
    assert.equal((await flow(['link-artifacts', a], { kind: 'tree' })).code, 1);
  });
});
