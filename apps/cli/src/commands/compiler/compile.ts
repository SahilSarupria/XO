import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveDomainProfile, listDomainProfiles } from '@xo/compiler';
import {
  artifactOpenWork,
  assessCompleteness,
  buildCapabilityInventory,
  buildSourceSet,
  compileSourceSet,
  confirmedRulesFrom,
  defaultCompileConfiguration,
  type HumanRuling,
  type SourceSetMember,
} from '@xo/pre-execution';
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
  /** PX-1: write the complete compilation artifact (`@xo/pre-execution`) as JSON to this path. */
  readonly artifactPath?: string;
  /** PX-5: write the capability inventory (statuses, four readiness answers, human task contracts, gaps) to this path. */
  readonly inventoryPath?: string;
  /** PX-3: a JSON file of human rulings (an array of `HumanRuling`). Confirm-rule rulings for this source set compile as confirmed rules. */
  readonly rulingsPath?: string;
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

  if (options.profile !== undefined && options.profile !== 'auto' && resolveDomainProfile(options.profile) === undefined) {
    return failWith(
      `unknown domain profile "${options.profile}" (known: ${listDomainProfiles()
        .map((p) => p.id)
        .join(', ')})`,
    );
  }

  let collected: Awaited<ReturnType<typeof collectSources>>;
  try {
    collected =
      options.sources.length > 0
        ? await collectSources(options.sources)
        : { inputs: [], entries: [], discovered: [], unsupported: [], cleanup: async () => undefined };
  } catch (cause) {
    return failWith(`could not read source(s): ${(cause as Error).message}`);
  }

  try {
    // PX-1: the same entry point and configuration type the API uses, so the same sources give the same artifact digest.
    let rulings: readonly HumanRuling[] = [];
    if (options.rulingsPath !== undefined) {
      try {
        const parsed = JSON.parse(await readFile(options.rulingsPath, 'utf8')) as unknown;
        if (!Array.isArray(parsed)) return failWith(`${options.rulingsPath} must hold a JSON array of rulings`);
        rulings = parsed as HumanRuling[];
      } catch (cause) {
        return failWith(`could not read rulings: ${(cause as Error).message}`);
      }
    }
    const configuration = defaultCompileConfiguration({
      ...(options.domainHint !== undefined ? { domainHint: options.domainHint } : {}),
      ...(options.focusQuestion !== undefined ? { focusQuestion: options.focusQuestion } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
    });
    const members: SourceSetMember[] = [
      ...collected.inputs.map((input, i) => ({ entry: collected.entries[i]!, input })),
      ...prompts.map((text, i) => {
        const bytes = new TextEncoder().encode(text);
        return {
          entry: {
            sourceId: `prompt:${i + 1}`,
            digestSha256: createHash('sha256').update(bytes).digest('hex'),
            name: `prompt-${i + 1}`,
            byteSize: bytes.length,
            role: 'instruction' as const,
          },
          input: {
            kind: 'prompt' as const,
            text,
            sourcePath: `prompt-${i + 1}`,
            ...(options.confirmedBy !== undefined ? { confirmedBy: options.confirmedBy } : {}),
          },
        };
      }),
    ];
    const setId = members.length > 0 ? buildSourceSet(members.map((mm) => mm.entry)).sourceSetId : undefined;
    const confirmed = setId !== undefined ? confirmedRulesFrom(rulings, setId) : [];
    const compiledSet = await compileSourceSet(
      members,
      confirmed.length > 0 ? { ...configuration, confirmedRules: confirmed } : configuration,
    );
    const result = compiledSet.ok ? { ok: true as const, value: compiledSet.value.result } : compiledSet;
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
    const artifact = compiledSet.ok ? compiledSet.value.artifact : undefined;
    if (options.artifactPath !== undefined && artifact !== undefined)
      await writeFile(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    const openWork = artifact !== undefined ? artifactOpenWork(artifact) : undefined;
    const completeness = artifact !== undefined ? assessCompleteness(artifact, rulings) : undefined;
    const inventory =
      options.inventoryPath !== undefined
        ? buildCapabilityInventory(value.graph, artifact !== undefined ? { artifactDigest: artifact.digest } : {})
        : undefined;
    if (options.inventoryPath !== undefined && inventory !== undefined)
      await writeFile(options.inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

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
          ...(artifact !== undefined
            ? {
                sourceSetId: artifact.sourceSet.sourceSetId,
                artifactDigest: artifact.digest,
                configurationDigest: artifact.configurationDigest,
                openWork,
                completeness,
              }
            : {}),
          ...(inventory !== undefined ? { inventoryDigest: inventory.digest, inventoryCounts: inventory.counts } : {}),
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
    if (artifact !== undefined && openWork !== undefined) {
      lines.push(
        `Source set:         ${artifact.sourceSet.sourceSetId}`,
        `Artifact digest:    ${artifact.digest}`,
        `Open work:          ${openWork.reviewItems} review item(s), ${openWork.unclassified} unclassified sentence(s), ${openWork.unresolvedConflicts} unresolved conflict(s)`,
      );
      if (completeness !== undefined) {
        const open = completeness.dimensions.filter((d) => d.status === 'incomplete');
        lines.push(
          `Completeness:       ${completeness.complete ? 'complete' : `incomplete (${open.map((d) => `${d.id} ${d.open.length}`).join(', ')})`}`,
        );
        for (const st of completeness.staleRulings) lines.push(`Stale ruling:       ${st.rulingId} — ${st.reason}`);
      }
      for (const note of artifact.runNotes) lines.push(`Note: ${note}`);
      if (options.artifactPath !== undefined) lines.push(`Artifact written:   ${options.artifactPath}`);
    }
    if (inventory !== undefined) {
      const c = inventory.counts;
      lines.push(
        `Capabilities:       ${c.total} (${c.explicit} explicit, ${c.inferred} inferred, ${c.unresolved} unresolved, ${c.duplicate} duplicate, ${c.unsupported} unsupported); runnable only after approval at start`,
      );
      lines.push(`Inventory written:  ${options.inventoryPath}`);
    }

    return { exitCode: value.valid ? 0 : 1, lines };
  } finally {
    await collected.cleanup();
  }
}
