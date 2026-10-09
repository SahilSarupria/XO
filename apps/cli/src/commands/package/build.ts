import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { XoMetadata } from '@xo/types';
import { Ed25519Signer } from '@xo/crypto';
import { ManifestBuilder, packBundle, PackageSigner, PackageValidator } from '@xo/package-sdk';
import type { CommandResult } from '../../command-result.js';
import { failWith } from '../../command-result.js';
import { readProjectConfig } from './project-config.js';

export interface BuildOptions {
  readonly dir: string;
  readonly out?: string;
  /** Sign the built package with a freshly generated Ed25519 development key. There is no other key source here — see README "Known limitations" on key custody. */
  readonly sign?: boolean;
  readonly signerDid?: string;
  /** Writes the generated development keypair to `<keyOut>.private.pem` / `<keyOut>.public.pem` so it can be reused with `xo verify --pubkey`. */
  readonly keyOut?: string;
}

/**
 * `init` -> `build` -> `verify`/`install` is the intended flow. This
 * command does no hashing, Merkle, packing, signing, or validation logic
 * of its own — every one of those steps below is a direct call into
 * `@xo/package-sdk`'s public API; this file's own work is limited to
 * reading project files off disk and turning `Result`s into
 * `CommandResult`s.
 */
export async function buildCommand(options: BuildOptions): Promise<CommandResult> {
  const lines: string[] = [];
  const configResult = await readProjectConfig(options.dir);
  if (!configResult.ok) return failWith(configResult.error.message);
  const config = configResult.value;

  lines.push(`Building "${config.name}@${config.version}" from ${options.dir}`);

  let builder = ManifestBuilder.create()
    .setIdentity({ formatVersion: config.formatVersion, name: config.name, version: config.version, creatorDid: config.creatorDid })
    .setCompatibility(config.compatibility);

  let metadataRaw: string;
  try {
    metadataRaw = await readFile(join(options.dir, config.metadataPath), 'utf8');
  } catch (cause) {
    return failWith(`could not read metadata file "${config.metadataPath}": ${(cause as Error).message}`);
  }
  builder = builder.setMetadata(JSON.parse(metadataRaw) as XoMetadata);

  for (const component of config.components) {
    let data: Buffer;
    try {
      data = await readFile(join(options.dir, component.path));
    } catch (cause) {
      return failWith(`could not read component file "${component.path}" (${component.kind}): ${(cause as Error).message}`);
    }
    builder = builder.addComponent({ kind: component.kind, path: component.path, data: new Uint8Array(data), required: component.required });
    lines.push(`  + ${component.kind.padEnd(20)} <- ${component.path}  (${data.byteLength} bytes)`);
  }

  const unsignedResult = builder.build();
  if (!unsignedResult.ok) return { exitCode: 1, lines: [...lines, `error: ${unsignedResult.error.message}`] };
  lines.push(`  merkleRoot: ${unsignedResult.value.manifest.merkleRoot}`);

  let bundle = unsignedResult.value;

  if (options.sign) {
    const signer = new Ed25519Signer();
    const keyPair = signer.generateKeyPair();
    const signerDid = options.signerDid ?? `did:xo:dev-${config.name}`;
    const entry = new PackageSigner(signer).sign(bundle.manifest, signerDid, 'creator', keyPair.privateKey, keyPair.publicKey);

    const signedResult = builder.addSignature(entry).build();
    if (!signedResult.ok) return { exitCode: 1, lines: [...lines, `error: ${signedResult.error.message}`] };
    bundle = signedResult.value;
    lines.push(`  signed by ${signerDid} using a freshly generated development key (NOT for production use)`);

    if (options.keyOut) {
      await writeFile(`${options.keyOut}.private.pem`, keyPair.privateKey, 'utf8');
      await writeFile(`${options.keyOut}.public.pem`, keyPair.publicKey, 'utf8');
      lines.push(`  wrote development keypair to ${options.keyOut}.private.pem / ${options.keyOut}.public.pem`);
    }
  }

  const report = new PackageValidator().validateAll(bundle);
  for (const issue of report.issues) lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  if (!report.valid) return { exitCode: 1, lines: [...lines, 'error: built package failed validation — see issues above'] };

  const archiveBytes = await packBundle(bundle);
  const outPath = options.out ?? join(options.dir, `${config.name}-${config.version}.xo`);
  await writeFile(outPath, archiveBytes);
  lines.push(`  wrote ${archiveBytes.byteLength} bytes to ${outPath}`);

  return { exitCode: 0, lines };
}
