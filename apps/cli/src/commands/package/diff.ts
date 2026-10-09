import { readFile } from 'node:fs/promises';
import { comparePackages, generateUpgradePlan, unpackArchive, type PackageBundle } from '@xo/package-sdk';
import type { CommandResult } from '../../command-result.js';
import { failWith } from '../../command-result.js';

export interface DiffOptions {
  readonly fromPath: string;
  readonly toPath: string;
}

async function loadBundle(path: string): Promise<{ readonly ok: true; readonly bundle: PackageBundle } | { readonly ok: false; readonly message: string }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (cause) {
    return { ok: false, message: `could not read "${path}": ${(cause as Error).message}` };
  }
  const result = await unpackArchive(bytes);
  if (!result.ok) return { ok: false, message: result.error.message };
  return { ok: true, bundle: result.value };
}

/** Exit code 0 when `generateUpgradePlan` reports `safe`, 1 otherwise — so `xo diff old.xo new.xo || fail-the-build` blocks an upgrade that would, e.g., drop a required component, in CI. */
export async function diffCommand(options: DiffOptions): Promise<CommandResult> {
  const from = await loadBundle(options.fromPath);
  if (!from.ok) return failWith(from.message);
  const to = await loadBundle(options.toPath);
  if (!to.ok) return failWith(to.message);

  const diff = comparePackages(from.bundle, to.bundle);
  const plan = generateUpgradePlan(from.bundle, to.bundle);

  const lines: string[] = [`${diff.manifest.fromVersion} -> ${diff.manifest.toVersion}  (${diff.manifest.versionBump})`];
  if (diff.manifest.nameChanged) lines.push(`  name changed: "${from.bundle.manifest.name}" -> "${to.bundle.manifest.name}"`);
  if (diff.manifest.compatibilityChanged) lines.push('  compatibility declaration changed');

  lines.push('Components:');
  for (const c of diff.components) lines.push(`  ${c.change.padEnd(9)} ${c.kind}`);

  lines.push('Upgrade plan:');
  for (const step of plan.steps) lines.push(`  - ${step.description}`);
  lines.push(plan.safe ? 'SAFE' : 'UNSAFE');
  for (const reason of plan.reasons) lines.push(`  reason: ${reason}`);

  return { exitCode: plan.safe ? 0 : 1, lines };
}
