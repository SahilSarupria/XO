import { compileSources, resolveDomainProfile, listDomainProfiles, type CompileSourcesOptions } from '@xo/compiler';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { collectSources } from './source-collection.js';

export interface CompileOptions {
  readonly sources: readonly string[];
  readonly domainHint?: string;
  readonly focusQuestion?: string;
  /** Natural-language instruction(s) to compile as `user_instruction` sources. They only contribute once `confirmedBy` is set. */
  readonly prompts?: readonly string[];
  /** Identity of the person who reviewed and confirmed the prompt interpretation(s). */
  readonly confirmedBy?: string;
  /** Domain profile id whose vocabulary extends the neutral grammar for this compilation. */
  readonly profile?: string;
  readonly json?: boolean;
}

/**
 * `xo compile <source...>` — the CLI's first real seam into `@xo/compiler`.
 * Does no parsing, extraction, or graph construction itself: each
 * positional argument is expanded by `collectSources`
 * (`source-collection.ts` — a file, a directory walked recursively, or
 * a `.zip` extracted and walked) into tagged `SourceInput`s, and the
 * whole batch is handed to `compileSources` — the single Stage 8 entry
 * point (source -> frontend -> chunk -> knowledge/capability/reasoning
 * extraction -> XOIR). Everything printed below is read directly off
 * `CompileSourcesResult` (`sources[]`, `stats`, `validation`,
 * `diagnostics`) — nothing here recomputes a count or re-derives a
 * status the compiler already reports.
 */
export async function compileCommand(options: CompileOptions): Promise<CommandResult> {
  const prompts = options.prompts ?? [];
  if (options.sources.length === 0 && prompts.length === 0) return failWith('at least one source path or --prompt is required');

  let lexicon: CompileSourcesOptions['lexicon'];
  const autoProfile = options.profile === 'auto';
  if (options.profile !== undefined && !autoProfile) {
    const profile = resolveDomainProfile(options.profile);
    if (profile === undefined) {
      return failWith(
        `unknown domain profile "${options.profile}" (known: ${listDomainProfiles()
          .map((p) => p.id)
          .join(', ')})`,
      );
    }
    lexicon = profile.lexicon;
  }

  let collected: Awaited<ReturnType<typeof collectSources>>;
  try {
    collected =
      options.sources.length > 0
        ? await collectSources(options.sources)
        : { inputs: [], discovered: [], unsupported: [], cleanup: async () => undefined };
  } catch (cause) {
    return failWith(`could not read source(s): ${(cause as Error).message}`);
  }

  try {
    const compileOptions: CompileSourcesOptions = {
      ...(options.domainHint !== undefined ? { domainHint: options.domainHint } : {}),
      ...(options.focusQuestion !== undefined ? { focusQuestion: options.focusQuestion } : {}),
      ...(lexicon !== undefined ? { lexicon } : {}),
      ...(autoProfile ? { autoProfile: true } : {}),
    };

    const promptInputs = prompts.map((text, i) => ({
      kind: 'prompt' as const,
      text,
      sourcePath: `prompt-${i + 1}`,
      ...(options.confirmedBy !== undefined ? { confirmedBy: options.confirmedBy } : {}),
    }));
    const result = await compileSources([...collected.inputs, ...promptInputs], compileOptions);
    if (!result.ok) {
      const lines = [`[${result.error.code}] ${result.error.message}`];
      const interpretations = (
        result.error.context as
          | {
              promptInterpretations?: readonly {
                sourcePath: string;
                interpretation: { status: string; questions: readonly { reason: string; question: string }[] };
              }[];
            }
          | undefined
      )?.promptInterpretations;
      for (const p of interpretations ?? []) {
        lines.push(`  ${p.sourcePath}: ${p.interpretation.status}`);
        for (const q of p.interpretation.questions) lines.push(`    [${q.reason}] ${q.question}`);
      }
      return { exitCode: 1, lines };
    }

    const { value } = result;

    if (options.json) {
      return ok([
        JSON.stringify({
          discoveredSources: collected.discovered.map((d) => d.declaredPath),
          unsupportedFiles: collected.unsupported,
          sources: value.sources,
          stats: value.stats,
          valid: value.valid,
          validationIssues: value.validation.issues,
          diagnostics: value.diagnostics,
          ...(value.promptInterpretations !== undefined ? { promptInterpretations: value.promptInterpretations } : {}),
          graphContentHash: value.graph.contentHash(),
        }),
      ]);
    }

    const lines: string[] = ['Sources:'];
    for (const s of value.sources) {
      lines.push(
        `  ${s.sourcePath}  (${s.sourceType})  ${s.semanticExtractionAvailable ? `${s.unitCount} unit(s)` : 'no semantic extraction available'}`,
      );
    }
    if (collected.unsupported.length > 0) {
      lines.push('', `Ignored ${collected.unsupported.length} unsupported file(s):`);
      for (const u of collected.unsupported.slice(0, 10)) lines.push(`  ${u.relativePath}  (${u.reason})`);
      if (collected.unsupported.length > 10) lines.push(`  ... and ${collected.unsupported.length - 10} more`);
    }

    lines.push('', 'Compilation:', `  nodes:   ${value.stats.nodeCount}`, `  edges:   ${value.stats.edgeCount}`);
    const kinds = Object.entries(value.stats.nodesByKind).sort(([a], [b]) => a.localeCompare(b));
    for (const [kind, count] of kinds) lines.push(`    ${kind.padEnd(20)} ${count}`);

    lines.push('', `Validation: ${value.valid ? 'valid' : 'INVALID'}`);
    for (const issue of value.validation.issues)
      lines.push(`  [${issue.kind}]${issue.subjectId ? ` (${issue.subjectId})` : ''} ${issue.message}`);

    const warnings = value.diagnostics.filter((d) => d.severity !== 'info');
    if (warnings.length > 0) {
      lines.push('', 'Diagnostics:');
      for (const d of warnings) lines.push(`  [${d.severity}] (${d.passName}) ${d.message}`);
    }

    lines.push('', `Graph content hash: ${value.graph.contentHash()}`);

    return { exitCode: value.valid ? 0 : 1, lines };
  } finally {
    await collected.cleanup();
  }
}
