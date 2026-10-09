import { writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { compileSources, packageXoirGraph, type CompileSourcesOptions } from '@xo/compiler';
import { nodesOfKind } from '@xo/xoir';
import { PackageSigner, PackageValidator, packBundle } from '@xo/package-sdk';
import type { PackageBundle } from '@xo/package-sdk';
import { Ed25519Signer } from '@xo/crypto';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { collectSources } from './source-collection.js';

export interface CreateOptions {
  readonly sources: readonly string[];
  readonly name?: string;
  readonly version?: string;
  readonly creatorDid?: string;
  readonly domain?: string;
  readonly description?: string;
  readonly out?: string;
  readonly sign?: boolean;
  readonly signerDid?: string;
  readonly keyOut?: string;
  readonly domainHint?: string;
  readonly json?: boolean;
}

/**
 * `xo create <source...>` — the high-level workflow: source(s) -> each
 * positional arg expanded by `collectSources` (`source-collection.ts` —
 * a file, a recursively-walked directory, or an extracted `.zip`) ->
 * `@xo/compiler`'s `compileSources` -> XOIR -> `packageXoirGraph` (the
 * Packager, `@xo/compiler`'s own lowering to a `@xo/package-sdk`
 * `PackageBundle`) -> optional signing -> validation -> `packBundle` ->
 * `.xo` bytes on disk. Every one of those steps is a direct call into an
 * existing public API; this file's only original work is CLI plumbing
 * (resolving sources, deriving defaults, attaching an optional signature
 * to the already-built bundle, shaping the summary) — no manifest/
 * component construction happens here, matching
 * `commands/package/build.ts`'s own relationship to `@xo/package-sdk`.
 *
 * Signing an already-built `PackageBundle` does not require going back
 * through a `ManifestBuilder`: `PackageSigner.sign` only needs the
 * manifest's signable bytes and produces a plain `SignatureEntry`, so
 * attaching it is an immutable data-copy, not a re-derivation of any
 * hashing/Merkle logic `@xo/package-sdk` already did inside
 * `packageXoirGraph`.
 *
 * Capability lowering (discovered XOIR `capability` node -> resolved
 * `BindingOutcome` -> manifest-level `CapabilityDeclaration`) is
 * performed entirely inside `packageXoirGraph` (`@xo/compiler`'s
 * Packager) — this command does not invent, duplicate, or second-guess
 * that decision. `packaged.value.capabilities` (a `LowerCapabilitiesResult`)
 * is the packager's own audit trail of that lowering and is the only
 * source this command reads from for the discovered/resolved counts
 * below; it never derives "resolved" from anything else (e.g. `nodesOfKind`
 * counts XOIR `capability` nodes only — semantic discovery, not lowering
 * outcome — see `capabilities.ts`'s doc comment for the same discovered-
 * vs-resolved distinction applied there).
 *
 * The "determinism" line is a real, cheap check this command can make
 * truthfully: recompiling the same inputs a second, fully independent
 * time — with the same pinned clock, since `@xo/xoir`'s node hashing
 * deliberately includes `createdAt` as provenance — and comparing
 * `XoirGraph.contentHash()`. Not a claim borrowed from elsewhere, and
 * not conflated with ordinary wall-clock variance across two genuinely
 * separately-timed compiles, which is expected and not a defect. This
 * also implicitly covers a ZIP argument: `collectSources` only extracts
 * the archive once, and both compile calls read the same already-
 * extracted, already-declared-path-tagged inputs — a temp directory's
 * name never enters the comparison.
 */
export async function createCommand(options: CreateOptions): Promise<CommandResult> {
  if (options.sources.length === 0) return failWith('at least one source path is required');

  let collected: Awaited<ReturnType<typeof collectSources>>;
  try {
    collected = await collectSources(options.sources);
  } catch (cause) {
    return failWith(`could not read source(s): ${(cause as Error).message}`);
  }

  try {
    // Fix a single wall-clock read for this run and pass it into both
    // compile calls below — see this function's doc comment.
    const now = new Date().toISOString();
    const nowFn = () => now;
    const compileOptions: CompileSourcesOptions = { now: nowFn, ...(options.domainHint !== undefined ? { domainHint: options.domainHint } : {}) };

    const compiled = await compileSources(collected.inputs, compileOptions);
    if (!compiled.ok) return failWith(`[${compiled.error.code}] ${compiled.error.message}`);

    const recompiled = await compileSources(collected.inputs, compileOptions);
    const deterministic = recompiled.ok && recompiled.value.graph.contentHash() === compiled.value.graph.contentHash();

    const firstArg = options.sources[0]!;
    const firstArgName = basename(firstArg, extname(firstArg));
    const name = options.name ?? firstArgName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const version = options.version ?? '0.1.0';
    const creatorDid = options.creatorDid ?? `did:xo:dev-${name}`;

    const metadata = {
      domain: options.domain ?? 'unclassified',
      description: options.description ?? `Compiled from ${options.sources.join(', ')} (${collected.discovered.length} source file(s)).`,
      scope: compiled.value.sources.map((s) => `${s.sourcePath} (${s.sourceType}, ${s.unitCount} unit(s))`),
      limitations: options.domain === undefined ? ['Domain not classified — caller did not supply --domain; do not rely on this field for search/discovery.'] : [],
      tags: options.domain === undefined ? ['auto-generated-metadata'] : [],
    };

    const packaged = packageXoirGraph(compiled.value.graph, {
      identity: { name, version, creatorDid },
      metadata,
      upstreamDiagnostics: compiled.value.diagnostics,
    });
    if (!packaged.ok) return failWith(packaged.error.message);

    let bundle: PackageBundle = packaged.value.bundle;
    const signLines: string[] = [];

    if (options.sign) {
      const signer = new Ed25519Signer();
      const keyPair = signer.generateKeyPair();
      const signerDid = options.signerDid ?? creatorDid;
      const entry = new PackageSigner(signer).sign(bundle.manifest, signerDid, 'creator', keyPair.privateKey, keyPair.publicKey);
      bundle = { ...bundle, manifest: { ...bundle.manifest, signatures: [...(bundle.manifest.signatures ?? []), entry] } };
      signLines.push(`signed by ${signerDid} using a freshly generated development key (NOT for production use)`);

      if (options.keyOut) {
        await writeFile(`${options.keyOut}.private.pem`, keyPair.privateKey, 'utf8');
        await writeFile(`${options.keyOut}.public.pem`, keyPair.publicKey, 'utf8');
        signLines.push(`wrote development keypair to ${options.keyOut}.private.pem / ${options.keyOut}.public.pem`);
      }
    }

    const validation = new PackageValidator().validateAll(bundle);

    const outPath = options.out ?? `${name}-${version}.xo`;
    let archiveBytes: Uint8Array | undefined;
    if (validation.valid) {
      archiveBytes = await packBundle(bundle);
      await writeFile(outPath, archiveBytes);
    }

    // `packaged.value.capabilities` is the Packager's own record of what
    // it discovered vs. actually lowered into `manifest.capabilities` —
    // see this function's doc comment. `discoveredCapabilities` below
    // still comes from `nodesOfKind` (a plain XOIR node count) rather
    // than `capabilities.discoveredCount` only because the two are
    // defined to always agree (every discovered `capability` node is
    // exactly one `LoweredCapabilityOutcome`) and `nodesOfKind` is the
    // pre-existing, independently-verifiable count this file already
    // computed; `resolvedCapabilities`/`lowered` below come from nowhere
    // else.
    const discoveredCapabilities = nodesOfKind(compiled.value.graph, 'capability').length;
    const resolvedCapabilities = packaged.value.capabilities.resolvedCount;
    const lowered = packaged.value.capabilities.declarations.length;

    if (options.json) {
      return ok([
        JSON.stringify({
          discoveredSources: collected.discovered.map((d) => d.declaredPath),
          unsupportedFiles: collected.unsupported,
          sources: compiled.value.sources,
          stats: compiled.value.stats,
          discoveredCapabilities,
          resolvedCapabilities,
          loweredCapabilities: lowered,
          capabilityOutcomes: packaged.value.capabilities.outcomes,
          deterministic,
          signed: options.sign === true,
          packageValid: validation.valid,
          validationIssues: validation.issues,
          outPath: validation.valid ? outPath : null,
        }),
      ]);
    }

    const lines: string[] = ['Source:', ...options.sources.map((s) => `  ${s}`)];
    if (collected.discovered.length > options.sources.length || options.sources.length > 1) {
      lines.push('', `Discovered ${collected.discovered.length} source file(s):`, ...collected.discovered.map((d) => `  ${d.declaredPath}`));
    }
    if (collected.unsupported.length > 0) {
      lines.push('', `Ignored ${collected.unsupported.length} unsupported file(s):`);
      for (const u of collected.unsupported.slice(0, 10)) lines.push(`  ${u.relativePath}  (${u.reason})`);
      if (collected.unsupported.length > 10) lines.push(`  ... and ${collected.unsupported.length - 10} more`);
    }
    lines.push(
      '',
      'Compilation:',
      `  Knowledge:    ${compiled.value.stats.nodesByKind['concept'] ?? 0} concept, ${compiled.value.stats.nodesByKind['fact'] ?? 0} fact node(s)`,
      `  Capabilities: ${discoveredCapabilities} discovered`,
      `  Reasoning:    ${compiled.value.stats.nodesByKind['reasoning_step'] ?? 0} node(s)`,
      '',
      'Capabilities:',
      `  ${discoveredCapabilities} discovered`,
      `  ${resolvedCapabilities} resolved and lowered into manifest.capabilities`,
      ...(discoveredCapabilities > resolvedCapabilities
        ? [`  ${discoveredCapabilities - resolvedCapabilities} discovered but not resolved (no deterministic binding, or binding unresolved/ambiguous/denied — see "xo capabilities" for per-capability detail)`]
        : []),
      '',
      'Provenance:',
      `  ${compiled.value.graph.allNodes().every((n) => n.metadata.sourceRefs.length > 0) ? 'preserved on every node' : 'present, but not every node carries a sourceRef — see diagnostics'}`,
      '',
      'Determinism:',
      `  ${deterministic ? 'verified (recompiled inputs produced an identical graph content hash)' : 'NOT verified — recompiling produced a different graph content hash'}`,
      '',
      'Package:',
      `  signed:    ${options.sign ? 'yes' : 'no'}`,
      ...signLines.map((l) => `  ${l}`),
      `  validated: ${validation.valid ? 'yes' : 'NO'}`,
      ...validation.issues.map((i) => `    [${i.severity}] ${i.code}: ${i.message}`),
    );

    if (validation.valid) {
      lines.push('', `Wrote ${archiveBytes!.byteLength} bytes to ${outPath}`);
    } else {
      lines.push('', 'error: package failed validation — no .xo file was written');
    }

    return { exitCode: validation.valid ? 0 : 1, lines };
  } finally {
    await collected.cleanup();
  }
}
