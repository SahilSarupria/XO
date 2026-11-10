import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

it('the "embed in your app" example runs offline and says what it did (so it cannot silently rot)', () => {
  const script = fileURLToPath(new URL('../../../examples/host-app-demo/embed-workflow.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env['PATH'] ?? '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /c-1 \(250\):\s+completed/);
  assert.match(r.stdout, /c-2 \(25000\):\s+escalated/);
  assert.match(r.stdout, /records written: rec_1\n/); // the escalated claim sent nothing
  assert.match(r.stdout, /every anchored position matches/);
});
