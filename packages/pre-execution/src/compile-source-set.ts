/**
 * PX-1: the one compile entry point every surface uses.
 *
 * Given the sources (each with its compiler input and its source-set entry), a configuration and a runtime, it compiles them
 * in set order with options built only by `toCompileSourcesOptions`, and returns the compiler result together with the source
 * set and the complete, content-addressed artifact. The API persists the artifact; the CLI prints or writes it. The same
 * sources and configuration give the same artifact digest on both.
 */
import { compileSources, type CompileSourcesResult } from '@xo/compiler';
import { ErrorCode, XoError } from '@xo/errors';
import type { Result } from '@xo/types';
import { buildCompilationArtifact, type CompilationArtifact } from './compilation-artifact.js';
import { runtimeMatches, toCompileSourcesOptions, type CompileConfiguration, type CompileRuntime } from './compile-configuration.js';
import { buildSourceSet, type SourceSetEntry, type SourceSetManifest } from './source-set.js';

export interface SourceSetMember {
  readonly entry: SourceSetEntry;
  /** The compiler input for this source (`{kind:'pdf', bytes, sourcePath}`, `{kind:'docx', ...}`, ...). Its `sourcePath` should be `entry.name`. */
  readonly input: unknown;
}

export interface CompiledSourceSet {
  readonly result: CompileSourcesResult;
  readonly sourceSet: SourceSetManifest;
  readonly artifact: CompilationArtifact;
}

export async function compileSourceSet(
  members: readonly SourceSetMember[],
  configuration: CompileConfiguration,
  runtime: CompileRuntime = {},
): Promise<Result<CompiledSourceSet, XoError>> {
  const sourceSet = buildSourceSet(members.map((m) => m.entry));
  let options: ReturnType<typeof toCompileSourcesOptions>;
  try {
    options = toCompileSourcesOptions(configuration, runtime);
  } catch (cause) {
    return { ok: false, error: new XoError(ErrorCode.INVALID_ARGUMENT, cause instanceof Error ? cause.message : String(cause)) };
  }
  const compiled = await compileSources(
    members.map((m) => m.input),
    options,
  );
  if (!compiled.ok) return compiled;
  const match = runtimeMatches(configuration, runtime);
  const artifact = buildCompilationArtifact({
    result: compiled.value,
    sourceSet,
    configuration,
    ...(match.note !== undefined ? { runNotes: [match.note] } : {}),
  });
  return { ok: true, value: { result: compiled.value, sourceSet, artifact } };
}
