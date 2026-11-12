import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classify } from '../lib/classify.mjs';
import { encodePng } from '../lib/png.mjs';
import { Recorder } from '../lib/recorder.mjs';
import { buildReport } from '../lib/report.mjs';

const png = encodePng(2, 2, Buffer.alloc(16, 255));
const withRecorder = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'xo-recorder-test-'));
  try {
    fn(new Recorder({ outDir: dir, baselinesDir: join(dir, 'none'), mode: 'compare' }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a failed screen keeps a screenshot of what was on the page, under failures/', () => {
  withRecorder((rec, dir) => {
    rec.functionalFailure('desktop', 'setup-rules', 'A control was not found in time.', png);
    const [r] = rec.results;
    assert.equal(r.status, 'functional');
    assert.equal(r.failureShot, 'failures/desktop/setup-rules.png');
    assert.ok(existsSync(join(dir, r.failureShot)));
    assert.ok(readFileSync(join(dir, r.failureShot)).equals(png));
  });
});

test('a failed screen without a screenshot is still recorded', () => {
  withRecorder((rec) => {
    rec.functionalFailure('mobile', 'tasks', 'Missing.');
    assert.equal(rec.results[0].status, 'functional');
    assert.equal(rec.results[0].failureShot, undefined);
  });
});

test('the report points a reviewer at the failure screenshot and calls the run a regression, not infrastructure', () => {
  withRecorder((rec) => {
    rec.functionalFailure('desktop', 'setup-rules', 'A control was not found in time.', png);
    const verdict = classify({ results: rec.results });
    assert.equal(verdict.kind, 'regression');
    const text = buildReport({ verdict, results: rec.results, orphans: [], info: {}, mode: 'compare' });
    assert.match(text, /desktop\/setup-rules \| DID NOT BEHAVE AS EXPECTED/);
    assert.match(text, /failures\/desktop\/setup-rules\.png/);
  });
});

test('one failed screen does not stop other screens from being recorded', () => {
  withRecorder((rec) => {
    rec.functionalFailure('desktop', 'setup-rules', 'Missing.', png);
    rec.submit('desktop', 'home', png);
    assert.deepEqual(
      rec.results.map((r) => r.id),
      ['desktop/setup-rules', 'desktop/home'],
    );
  });
});
