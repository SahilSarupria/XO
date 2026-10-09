import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '@xo/types';
/**
 * This is a contract test, not an implementation: it verifies the
 * `Compiler` interface shape is actually satisfiable and usable by a
 * caller, without providing any real compilation logic. A genuine
 * Experience Compiler is out of scope for this module.
 */
class FakeCompilerForContractTesting {
    async compile(input) {
        return ok({
            ir: { formatVersion: '0.1.0', domain: input.domain, sections: {} },
            stages: [{ stage: 'ingest', durationMs: 0, warnings: [] }],
        });
    }
}
test('a Compiler implementation can be constructed and invoked', async () => {
    const compiler = new FakeCompilerForContractTesting();
    const result = await compiler.compile({ domain: 'test-domain', sourceDocuments: [] });
    assert.ok(result.ok);
    if (result.ok) {
        assert.equal(result.value.ir.domain, 'test-domain');
        assert.equal(result.value.stages[0]?.stage, 'ingest');
    }
});
//# sourceMappingURL=compiler-interface.test.js.map