import { err, ok, type Result } from '@xo/types';
import { ErrorCode, XoError } from '@xo/errors';
import { fromJson, toJson, type XoirGraphJson } from '@xo/xoir';
import { compileXoir } from '@xo/compiler';
import type { PipelineInput } from '@xo/compiler';

/**
 * THE isolation boundary. `packages/compiler/src/pipeline/compile.ts`
 * is, per the task brief, "the one genuinely volatile surface in this
 * task" — Compiler Stage 6, running concurrently in another chat, is
 * specifically about changing what it returns. Nothing outside this
 * file — not `compiler-routes.ts`, not the OpenAPI doc, not the router,
 * not error-mapping — imports `@xo/compiler` or knows anything about
 * `PipelineInput`/`CompiledXoirResult`'s shape. When Stage 6 lands and
 * changes that shape, this file is the entire blast radius: update
 * `HttpCompileResponse` and the two conversions below, and every other
 * file in `apps/api` keeps compiling and keeps working unchanged.
 *
 * Scope, deliberately narrower than the full `PipelineInput` union:
 * only `kind: 'xoir'` is accepted over HTTP today. `@xo/xoir` ships a
 * tested, safe JSON boundary for `XoirGraph` (`fromJson`/`toJson`,
 * `serialization.ts`) — casting arbitrary client JSON straight into
 * `KnowledgeGraph`/`CapabilityGraph` has no equivalent safe parser
 * anywhere in this codebase today (neither type exposes a `fromJson`),
 * so doing that here would risk an uncaught `TypeError` deep inside
 * `compileXoir` instead of a clean 4xx. `'knowledge'`/`'capability'`/
 * `'combined'` return a deliberate "not available over HTTP yet"
 * response (`ErrorCode.UNIMPLEMENTED`) rather than a crash — this is a
 * scoping decision, not an oversight; the natural place for Stage 6 (or
 * a follow-up) to add real schemas for those two types and widen this
 * adapter accordingly.
 */

export interface HttpCompileRequest {
  readonly kind?: unknown;
  readonly graph?: unknown;
  readonly graphId?: unknown;
}

/** The HTTP-facing mirror of `CompiledXoirResult` — same fields, but `graph: XoirGraphJson` (wire-safe) instead of `graph: XoirGraph` (a class instance with methods; `JSON.stringify`-ing it directly would silently drop its actual node/edge data, the same trap `runtime-routes.ts` avoids for `PackageRegistry`/`CapabilityRegistry`). Everything else in `CompiledXoirResult` (`valid`, `validation`, `diagnostics`, `passRuns`, `stats`) is already a plain interface — see the comment in this file's implementation for how that was verified. */
export interface HttpCompileResponse {
  readonly graph: XoirGraphJson;
  readonly valid: boolean;
  readonly validation: unknown;
  readonly diagnostics: unknown;
  readonly passRuns: unknown;
  readonly stats: unknown;
}

function parseInput(body: HttpCompileRequest): Result<PipelineInput, XoError> {
  if (body.kind === 'knowledge' || body.kind === 'capability' || body.kind === 'combined') {
    return err(new XoError(ErrorCode.UNIMPLEMENTED, `compiling from "${body.kind}" input is not available over this API yet — only "xoir" input is currently supported (see compileAdapter.ts for why)`));
  }
  if (body.kind !== 'xoir') {
    return err(new XoError(ErrorCode.INVALID_ARGUMENT, '"kind" must be "xoir" ("knowledge"/"capability"/"combined" are recognized but not yet supported over HTTP — see compileAdapter.ts)'));
  }
  if (typeof body.graph !== 'object' || body.graph === null) {
    return err(new XoError(ErrorCode.INVALID_ARGUMENT, '"graph" (a XoirGraphJson object) is required for kind "xoir"'));
  }

  const parsedGraph = fromJson(body.graph as XoirGraphJson);
  if (!parsedGraph.ok) return err(parsedGraph.error);

  return ok({ kind: 'xoir', graph: parsedGraph.value });
}

/**
 * The single function every route/test in `apps/api` calls. Owns:
 * request-shape validation, the `PipelineInput` construction, the
 * `compileXoir` call itself, and the `CompiledXoirResult ->
 * HttpCompileResponse` conversion. Never throws for a bad request body
 * or a domain-level compile failure (both come back as `Result` errors
 * or a `valid: false` response, matching `compileXoir`'s own "err() is
 * reserved for genuine system failure" contract) — an unexpected
 * exception from deep inside `@xo/compiler` is the one case this
 * function lets propagate uncaught, since `server.ts`'s top-level
 * handler already maps any thrown error safely and there is nothing
 * more specific to say about a failure this function didn't anticipate.
 */
export async function compileViaHttp(body: HttpCompileRequest): Promise<Result<HttpCompileResponse, XoError>> {
  const inputResult = parseInput(body);
  if (!inputResult.ok) return err(inputResult.error);

  const options = typeof body.graphId === 'string' ? { graphId: body.graphId } : {};
  const compileResult = await compileXoir(inputResult.value, options);
  if (!compileResult.ok) return err(compileResult.error);

  const result = compileResult.value;
  return ok({
    graph: toJson(result.graph),
    valid: result.valid,
    validation: result.validation,
    diagnostics: result.diagnostics,
    passRuns: result.passRuns,
    stats: result.stats,
  });
}
