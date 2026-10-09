import { readFile } from 'node:fs/promises';
import { fingerprintManifest, unpackArchive } from '@xo/package-sdk';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';

/** Prints exactly one line — the fingerprint — on success, so `xo fingerprint pkg.xo` is safe to use directly in shell substitution (`FP=$(xo fingerprint pkg.xo)`). */
export async function fingerprintCommand(archivePath: string): Promise<CommandResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(archivePath));
  } catch (cause) {
    return failWith(`could not read "${archivePath}": ${(cause as Error).message}`);
  }

  const result = await unpackArchive(bytes);
  if (!result.ok) return failWith(result.error.message);

  return ok([fingerprintManifest(result.value.manifest)]);
}
