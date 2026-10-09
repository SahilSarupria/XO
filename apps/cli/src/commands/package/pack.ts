import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprintManifest, unpackArchive } from '@xo/package-sdk';
import type { CommandResult } from '../../command-result.js';
import { failWith } from '../../command-result.js';
import { buildCommand, type BuildOptions } from './build.js';
import { readProjectConfig } from './project-config.js';

export type PackOptions = BuildOptions;

const DOCUMENT_COMPILATION_NOT_AVAILABLE = [
  'xo pack does not compile a raw document (PDF, etc.) into a package — it only packages',
  'an already-scaffolded project directory (the xo.project.json + component-files layout',
  '"xo build" also consumes).',
  '',
  'To go straight from a raw source to a signed, validated .xo, use "xo create <source>"',
  'instead — it calls @xo/compiler\'s compileSources/packageXoirGraph directly and does not',
  'require a project directory at all.',
  '',
  'Or, run "xo init <dir>" to scaffold a project directory, then point "xo pack" at it.',
];

/**
 * `xo pack <path>` is an additive command, not a replacement for `xo
 * build` — `build.ts` is untouched. For a project directory (the only
 * case this can support today — see `DOCUMENT_COMPILATION_NOT_AVAILABLE`
 * above for why the document/PDF case is out of scope), `pack` delegates
 * the entire build — hashing, Merkle, signing, validation, archiving —
 * to `buildCommand`, which already does all of that through
 * `@xo/package-sdk`'s public API. This file's only original work is:
 * (1) telling a document path apart from a project directory before
 * `buildCommand` ever runs, and (2) once `buildCommand` has written the
 * archive, reading it back with `@xo/package-sdk`'s own
 * `unpackArchive`/`fingerprintManifest` to print the
 * name/version/fingerprint/component summary the task asked for — never
 * recomputing a fingerprint or manifest by hand.
 */
export async function packCommand(options: PackOptions): Promise<CommandResult> {
  let stats;
  try {
    stats = await stat(options.dir);
  } catch (cause) {
    return failWith(`could not read "${options.dir}": ${(cause as Error).message}`);
  }

  if (!stats.isDirectory()) {
    return failWith(DOCUMENT_COMPILATION_NOT_AVAILABLE.join('\n'));
  }

  const buildResult = await buildCommand(options);
  if (buildResult.exitCode !== 0) return buildResult;

  // buildCommand succeeded, so xo.project.json is known-good — re-reading
  // it here is bookkeeping (recovering the output path build.ts already
  // derived), not a second attempt at packaging logic.
  const configResult = await readProjectConfig(options.dir);
  if (!configResult.ok) return { ...buildResult, lines: [...buildResult.lines, `warning: built package but could not re-read xo.project.json for the summary: ${configResult.error.message}`] };
  const config = configResult.value;
  const outPath = options.out ?? join(options.dir, `${config.name}-${config.version}.xo`);

  let archiveBytes: Uint8Array;
  try {
    archiveBytes = new Uint8Array(await readFile(outPath));
  } catch (cause) {
    return { ...buildResult, lines: [...buildResult.lines, `warning: built package but could not re-read "${outPath}" for the summary: ${(cause as Error).message}`] };
  }

  const readResult = await unpackArchive(archiveBytes);
  if (!readResult.ok) {
    return { ...buildResult, lines: [...buildResult.lines, `warning: built package but could not re-parse "${outPath}" for the summary: ${readResult.error.message}`] };
  }

  const { manifest } = readResult.value;
  const summary = [
    '',
    'Package summary:',
    `  name:          ${manifest.name}`,
    `  version:       ${manifest.version}`,
    `  fingerprint:   ${fingerprintManifest(manifest)}`,
    `  signed:        ${manifest.signatures && manifest.signatures.length > 0 ? `yes (${manifest.signatures.map((s) => s.signerDid).join(', ')})` : 'no'}`,
    '  components:',
    ...Object.entries(manifest.components).map(([kind, entry]) => `    - ${kind.padEnd(20)} ${entry.path}`),
  ];

  return { exitCode: 0, lines: [...buildResult.lines, ...summary] };
}
