import type { Diagnostic, Pass, PassContext, PassResult, XoirEdgeId, XoirNodeId } from '@xo/xoir';
import { validateGraph, type ValidationIssue, type ValidationReport } from '@xo/xoir';

export const XOIR_VALIDATION_PASS_NAME = 'xoir-validation';

/**
 * Maps a `@xo/xoir` `ValidationIssue` onto a `Diagnostic` (per Stage 6 §6
 * — "reuse existing XOIR validation behavior... do not duplicate the
 * validation rules inside the compiler"). Every issue `validateGraph` can
 * produce is a real structural/content problem, so every one becomes an
 * `'error'`-severity diagnostic — there is no separate warning-level
 * output from `validateGraph` today for this pass to downgrade.
 *
 * `issue.subjectId` is typed as `XoirNodeId | XoirEdgeId | undefined` in
 * `@xo/xoir` (it doesn't record which one), so this looks the id up
 * against the graph itself to decide whether to populate `nodeId` or
 * `edgeId` — never both, and neither when `subjectId` is undefined
 * (schema-version-level issues have no single subject).
 */
export function validationIssueToDiagnostic(issue: ValidationIssue, context: PassContext): Diagnostic {
  const code = `xoir-validation/${issue.kind}`;
  if (issue.subjectId === undefined) {
    return { severity: 'error', message: issue.message, passName: XOIR_VALIDATION_PASS_NAME, code };
  }
  if (context.graph.hasNode(issue.subjectId as unknown as XoirNodeId)) {
    return { severity: 'error', message: issue.message, passName: XOIR_VALIDATION_PASS_NAME, code, nodeId: issue.subjectId as unknown as XoirNodeId };
  }
  return { severity: 'error', message: issue.message, passName: XOIR_VALIDATION_PASS_NAME, code, edgeId: issue.subjectId as unknown as XoirEdgeId };
}

/**
 * The Stage 6 XOIR validation pass: runs `@xo/xoir#validateGraph` against
 * the pipeline's current graph and turns every `ValidationIssue` into a
 * structured `Diagnostic`. The graph itself is never mutated by this pass
 * (`PassResult.graph` is always the same reference it was given) — this
 * pass only *observes* the graph and reports on it; per Stage 6 §12,
 * "The XOIR validation pass should stop downstream compilation" on
 * failure is the pipeline orchestrator's job (`compile.ts`), not this
 * pass's — a `Pass` has no way to abort the `PassManager` early other
 * than throwing, and a validation failure is an expected, structured
 * outcome, not an exceptional one (matching `validateGraph`'s own "never
 * throws" contract).
 */
export function createXoirValidationPass(): Pass {
  return {
    name: XOIR_VALIDATION_PASS_NAME,
    run(context: PassContext): PassResult {
      const report: ValidationReport = validateGraph(context.graph);
      const diagnostics = report.issues.map((issue) => validationIssueToDiagnostic(issue, context));
      return { graph: context.graph, diagnostics };
    },
  };
}
