import { noopLogger } from '@xo/logger';
import { err, ok } from '@xo/types';
import { XoirError, ErrorCode } from '@xo/errors';
/**
 * Cooperative cancellation: a pass checks `token.isCancelled` at
 * reasonable points (e.g. once per node in a long traversal) and returns
 * early if set. There is no forced/preemptive cancellation — passes are
 * plain synchronous or async functions, not workers that can be killed
 * out-of-band.
 */
export class CancellationToken {
    cancelled = false;
    get isCancelled() {
        return this.cancelled;
    }
    cancel() {
        this.cancelled = true;
    }
}
/**
 * Registers passes and runs them in an order that respects `dependsOn`
 * (a stable topological sort — passes with no ordering constraint between
 * them run in registration order), threading the graph from one pass's
 * output to the next pass's input. Stops early (without running remaining
 * passes) if the shared `CancellationToken` is set or a pass throws.
 */
export class PassManager {
    passes = new Map();
    register(pass) {
        this.passes.set(pass.name, pass);
    }
    order() {
        const visited = new Set();
        const visiting = new Set();
        const ordered = [];
        const visit = (name) => {
            if (visited.has(name))
                return ok(undefined);
            if (visiting.has(name)) {
                return err(new XoirError(ErrorCode.XOIR_CYCLE_DETECTED, `Pass dependency cycle detected at "${name}"`));
            }
            const pass = this.passes.get(name);
            if (!pass) {
                return err(new XoirError(ErrorCode.XOIR_PASS_FAILED, `Pass "${name}" is listed as a dependency but was never registered`));
            }
            visiting.add(name);
            for (const dep of pass.dependsOn ?? []) {
                const result = visit(dep);
                if (!result.ok)
                    return result;
            }
            visiting.delete(name);
            visited.add(name);
            ordered.push(pass);
            return ok(undefined);
        };
        for (const name of this.passes.keys()) {
            const result = visit(name);
            if (!result.ok)
                return err(result.error);
        }
        return ok(ordered);
    }
    async run(graph, options = {}) {
        const orderResult = this.order();
        if (!orderResult.ok)
            return err(orderResult.error);
        const logger = options.logger ?? noopLogger;
        const cancellationToken = options.cancellationToken ?? new CancellationToken();
        const runs = [];
        const allDiagnostics = [];
        let currentGraph = graph;
        for (const pass of orderResult.value) {
            if (cancellationToken.isCancelled) {
                runs.push({ passName: pass.name, durationMs: 0, diagnostics: [], cancelled: true });
                continue;
            }
            const diagnostics = [];
            const context = { graph: currentGraph, logger: logger.child({ pass: pass.name }), cancellationToken, diagnostics };
            const startedAt = performance.now();
            let result;
            try {
                result = await pass.run(context);
            }
            catch (cause) {
                return err(new XoirError(ErrorCode.XOIR_PASS_FAILED, `Pass "${pass.name}" threw`, { cause }));
            }
            const durationMs = performance.now() - startedAt;
            const passDiagnostics = [...diagnostics, ...(result.diagnostics ?? [])];
            runs.push({ passName: pass.name, durationMs, diagnostics: passDiagnostics, cancelled: false });
            allDiagnostics.push(...passDiagnostics);
            currentGraph = result.graph;
        }
        return ok({ graph: currentGraph, runs, diagnostics: allDiagnostics });
    }
}
//# sourceMappingURL=pass.js.map