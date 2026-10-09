import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { Compiler, CompilationReport, CompilerInput } from '../src/compiler.interface.js';

/**
 * This is a contract test, not an implementation: it verifies the
 * `Compiler` interface shape is actually satisfiable and usable by a
 * caller, without providing any real compilation logic. A genuine
 * Experience Compiler is out of scope for this module.
 */
class FakeCompilerForContractTesting implements Compiler {
  async compile(input: CompilerInput): Promise<Result<CompilationReport, XoError>> {
    return ok({
      ir: { formatVersion: '0.1.0', domain: input.domain, sections: {} },
      stages: [{ stage: 'ingest', durationMs: 0, warnings: [] }],
    });
  }
}

test('a Compiler implementation can be constructed and invoked', async () => {
  const compiler: Compiler = new FakeCompilerForContractTesting();
  const result = await compiler.compile({ domain: 'test-domain', sourceDocuments: [] });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.value.ir.domain, 'test-domain');
    assert.equal(result.value.stages[0]?.stage, 'ingest');
  }
});
