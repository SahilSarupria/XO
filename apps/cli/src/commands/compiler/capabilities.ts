import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { compileSources, discoverAndResolveCapabilities, type CompileSourcesOptions } from '@xo/compiler';
import { nodesOfKind } from '@xo/xoir';
import { unpackArchive } from '@xo/package-sdk';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { collectSources } from './source-collection.js';

export interface CapabilitiesOptions {
  readonly target: string;
  readonly domainHint?: string;
  readonly json?: boolean;
}

/**
 * `xo capabilities <source-or-xo>`.
 *
 * There is no single "capability" concept in this platform to report on
 * — there are two, deliberately kept separate (see
 * `packages/runtime/src/capability-authority/runtime-capability-declaration.ts`'s
 * top doc comment, and `examples/e2e-pdf/run.ts`'s own recorded boundary
 * for why no converter between them exists):
 *
 *   - DISCOVERED: `capability`-kind XOIR nodes a compilation surfaced
 *     from source text — semantic analysis, not an invocation contract.
 *     Available for a raw source (this command compiles it) or, if the
 *     package's `knowledge_graph.json` component happens to embed them,
 *     for an already-built `.xo` (this command does not attempt that
 *     today — see the archive-mode branch below).
 *   - RESOLVED: entries in `manifest.capabilities`
 *     (`@xo/types#CapabilityDeclaration`) — an installable package's own
 *     *claim*, which is what `@xo/runtime`'s `CapabilityRegistry`/
 *     `CapabilityNegotiator` actually index and what `xo run` actually
 *     negotiates against.
 *
 * `@xo/compiler`'s Packager (`packageXoirGraph`, `pipeline/packager.ts`)
 * performs real capability lowering: discovered XOIR `capability` nodes
 * are each resolved against a `BindingResolver`, and every resolved
 * binding is promoted into a manifest-level `CapabilityDeclaration` via
 * `ManifestBuilder.setCapabilities`. Both branches below report RESOLVED
 * by calling that same Packager and reading its own
 * `LowerCapabilitiesResult` audit trail — never by re-implementing
 * resolution logic here, and never by asserting a resolved count without
 * actually invoking the lowering path that produces one.
 *
 *   - Archive mode reads `manifest.capabilities` directly off an
 *     already-built `.xo` — the package's own, already-settled claim.
 *   - Source mode has no manifest to read yet, so it runs the same
 *     `packageXoirGraph` call `xo create` would make (in memory only —
 *     no bundle is signed, validated, or written to disk here) purely to
 *     obtain its `capabilities` result. The identity/metadata passed in
 *     are placeholder preview values with no bearing on resolution
 *     itself (binding resolution depends only on the compiled graph and
 *     the resolver, never on package name/version/creator); this command
 *     never persists or returns that placeholder bundle.
 */
export async function capabilitiesCommand(options: CapabilitiesOptions): Promise<CommandResult> {
  if (extname(options.target).toLowerCase() === '.xo') {
    return capabilitiesFromArchive(options.target, options.json);
  }
  return capabilitiesFromSource(options.target, options.domainHint !== undefined ? { domainHint: options.domainHint } : {}, options.json);
}

async function capabilitiesFromArchive(archivePath: string, json?: boolean): Promise<CommandResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(archivePath));
  } catch (cause) {
    return failWith(`could not read "${archivePath}": ${(cause as Error).message}`);
  }

  const unpacked = await unpackArchive(bytes);
  if (!unpacked.ok) return failWith(unpacked.error.message);

  const declared = unpacked.value.manifest.capabilities ?? [];

  if (json) {
    return ok([JSON.stringify({ mode: 'archive', resolved: declared })]);
  }

  const lines: string[] = [`Resolved capabilities (manifest.capabilities): ${declared.length}`];
  if (declared.length === 0) {
    lines.push(
      '  (none) — this package declares no manifest-level CapabilityDeclarations.',
      '  Either the source had no discovered capabilities, or none of the discovered',
      '  capabilities resolved a deterministic binding at packaging time (unresolved,',
      '  ambiguous, or denied outcomes are discovered but never lowered — see',
      '  "xo capabilities <source-file>" for the per-capability discovery/resolution detail).',
    );
  } else {
    for (const cap of declared) {
      lines.push(
        `  - ${cap.id}  "${cap.name}"`,
        `      description:  ${cap.description}`,
        `      components:   ${cap.requiredComponents.join(', ') || '(none)'}`,
        `      families:     ${cap.providerCompatibility.join(', ') || '(none)'}`,
        `      confidence:   ${cap.confidence.score} (${cap.confidence.basis})`,
      );
    }
  }
  return ok(lines);
}

/**
 * `sourcePath` may be a single file, a directory (recursively walked),
 * or a `.zip` archive of sources — `collectSources`
 * (`source-collection.ts`) handles all three uniformly and is the same
 * path `compile.ts`/`create.ts` use, so "what capabilities would `xo
 * create ./company-documents` discover" and "what does `xo capabilities
 * ./company-documents` show" are answered by literally the same source
 * resolution and the same merged compilation.
 */
async function capabilitiesFromSource(sourcePath: string, options: Pick<CompileSourcesOptions, 'domainHint'>, json?: boolean): Promise<CommandResult> {
  let collected: Awaited<ReturnType<typeof collectSources>>;
  try {
    collected = await collectSources([sourcePath]);
  } catch (cause) {
    return failWith(`could not read "${sourcePath}": ${(cause as Error).message}`);
  }

  try {
    const result = await compileSources(collected.inputs, options);
    if (!result.ok) return failWith(`[${result.error.code}] ${result.error.message}`);

    const capabilityNodes = nodesOfKind(result.value.graph, 'capability');

    // Preview-only lowering via the shared `discoverAndResolveCapabilities` (P0.9B Step 5) — see this file's top doc comment. Never
    // signed, validated, or written to disk; used solely to obtain a
    // real `LowerCapabilitiesResult` for the resolved/lowered counts
    // below. Placeholder identity/metadata have no bearing on
    // resolution and are never surfaced to the caller.
    const resolved = discoverAndResolveCapabilities(result.value.graph, { previewLabel: 'xo capabilities preview' });
    if (!resolved.ok) return failWith(`could not determine resolved capabilities: ${resolved.error.message}`);
    const { resolvedCount, outcomes } = resolved.value;

    if (json) {
      return ok([
        JSON.stringify({
          mode: 'source',
          discoveredSources: collected.discovered.map((d) => d.declaredPath),
          unsupportedFiles: collected.unsupported,
          discovered: capabilityNodes.map((n) => ({
            id: n.id,
            name: n.properties.name,
            description: n.properties.description,
            category: n.properties.category,
            confidence: n.metadata.confidence,
          })),
          resolvedCount,
          outcomes,
        }),
      ]);
    }

    const lines: string[] = [];
    if (collected.discovered.length > 1) {
      lines.push(`Sources (${collected.discovered.length}):`, ...collected.discovered.map((d) => `  ${d.declaredPath}`), '');
    }
    lines.push(`Discovered capabilities (XOIR "capability" nodes): ${capabilityNodes.length}`);
    for (const node of capabilityNodes) {
      lines.push(
        `  - ${node.id}  "${node.properties.name}"${node.properties.category ? ` [${node.properties.category}]` : ''}`,
        `      description: ${node.properties.description}`,
        `      confidence:  ${node.metadata.confidence.toFixed(2)}`,
      );
    }
    lines.push(
      '',
      `Resolved capabilities (would lower into manifest-level CapabilityDeclaration if packaged): ${resolvedCount}`,
      '  Computed by running this compilation through the same Packager "xo create" uses',
      '  (preview only — nothing was signed, validated, or written to disk). Run',
      '  "xo create" to actually produce a package, or "xo capabilities <built.xo>" to read',
      '  the settled, on-disk manifest.capabilities of one already built.',
    );

    return ok(lines);
  } finally {
    await collected.cleanup();
  }
}
