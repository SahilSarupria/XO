import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import { err, ok, type Result } from '@xo/types';
import { XoirError, ErrorCode } from '@xo/errors';
import type { XoirGraph } from './graph.js';
import type { XoirNodeId, XoirEdgeId } from './ids.js';
import type { XoirSourceRef } from './node-kinds.js';

/**
 * Cooperative cancellation: a pass checks `token.isCancelled` at
 * reasonable points (e.g. once per node in a long traversal) and returns
 * early if set. There is no forced/preemptive cancellation — passes are
 * plain synchronous or async functions, not workers that can be killed
 * out-of-band.
 */
export class CancellationToken {
  private cancelled = false;

  get isCancelled(): boolean {
    return this.cancelled;
  }

  cancel(): void {
    this.cancelled = true;
  }
}

/**
 * A single machine-readable finding from a pass run. `severity`/
 * `message`/`passName` are the original, pre-Stage-6 shape and remain
 * required and unchanged. `code`/`nodeId`/`edgeId`/`sourceRef` are
 * additive (all optional) — added for Stage 6's compiler pipeline, which
 * needs diagnostics a caller can filter/group by machine-readable code
 * and trace back to the specific node/edge/piece of evidence responsible,
 * not just a human-readable string. A pass that only ever set the
 * original three fields (e.g. every pre-Stage-6 caller) is unaffected;
 * these fields are simply absent on its diagnostics.
 */
export interface Diagnostic {
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly passName: string;
  /** A short, stable, machine-readable identifier for what kind of finding this is (e.g. `'xoir-validation/missing_required_property'`), distinct from the free-text `message`. */
  readonly code?: string;
  readonly nodeId?: XoirNodeId;
  readonly edgeId?: XoirEdgeId;
  /** The specific piece of evidence this diagnostic concerns, when one is available (e.g. a normalization pass reporting which source a reconciled node's confidence now reflects). */
  readonly sourceRef?: XoirSourceRef;
}

export interface PassContext {
  readonly graph: XoirGraph;
  readonly logger: Logger;
  readonly cancellationToken: CancellationToken;
  readonly diagnostics: Diagnostic[];
}

export interface PassResult {
  readonly graph: XoirGraph;
  readonly diagnostics?: readonly Diagnostic[];
}

/**
 * The contract every future optimization/analysis/lowering pass
 * implements. This module implements no passes — see the module spec's
 * "Do NOT implement optimization" — only the interface a pass must
 * satisfy and the manager (below) that runs a set of them in dependency
 * order. `dependsOn` names other passes by `name`, not by import
 * reference, so passes can be registered/composed without a compile-time
 * dependency between pass *implementations* (only on this framework).
 */
export interface Pass {
  readonly name: string;
  readonly dependsOn?: readonly string[];
  run(context: PassContext): PassResult | Promise<PassResult>;
}

export interface PassRunSummary {
  readonly passName: string;
  readonly durationMs: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly cancelled: boolean;
}

export interface PassManagerReport {
  readonly graph: XoirGraph;
  readonly runs: readonly PassRunSummary[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Registers passes and runs them in an order that respects `dependsOn`
 * (a stable topological sort — passes with no ordering constraint between
 * them run in registration order), threading the graph from one pass's
 * output to the next pass's input. Stops early (without running remaining
 * passes) if the shared `CancellationToken` is set or a pass throws.
 */
export class PassManager {
  private readonly passes = new Map<string, Pass>();

  register(pass: Pass): void {
    this.passes.set(pass.name, pass);
  }

  private order(): Result<readonly Pass[], XoirError> {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const ordered: Pass[] = [];

    const visit = (name: string): Result<void, XoirError> => {
      if (visited.has(name)) return ok(undefined);
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
        if (!result.ok) return result;
      }
      visiting.delete(name);
      visited.add(name);
      ordered.push(pass);
      return ok(undefined);
    };

    for (const name of this.passes.keys()) {
      const result = visit(name);
      if (!result.ok) return err(result.error);
    }
    return ok(ordered);
  }

  async run(graph: XoirGraph, options: { logger?: Logger; cancellationToken?: CancellationToken } = {}): Promise<Result<PassManagerReport, XoirError>> {
    const orderResult = this.order();
    if (!orderResult.ok) return err(orderResult.error);

    const logger = options.logger ?? noopLogger;
    const cancellationToken = options.cancellationToken ?? new CancellationToken();
    const runs: PassRunSummary[] = [];
    const allDiagnostics: Diagnostic[] = [];
    let currentGraph = graph;

    for (const pass of orderResult.value) {
      if (cancellationToken.isCancelled) {
        runs.push({ passName: pass.name, durationMs: 0, diagnostics: [], cancelled: true });
        continue;
      }
      const diagnostics: Diagnostic[] = [];
      const context: PassContext = { graph: currentGraph, logger: logger.child({ pass: pass.name }), cancellationToken, diagnostics };
      const startedAt = performance.now();
      let result: PassResult;
      try {
        result = await pass.run(context);
      } catch (cause) {
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