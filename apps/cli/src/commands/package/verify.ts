import { readFile } from 'node:fs/promises';
import { PackageValidator, unpackArchive } from '@xo/package-sdk';
import type { ValidationIssue } from '@xo/package-sdk';
import type { CommandResult } from '../../command-result.js';
import { failWith } from '../../command-result.js';

export interface VerifyOptions {
  readonly archivePath: string;
  /** Each entry is `"<signerDid>=<path/to/public-key.pem>"`, as passed via repeated `--pubkey` flags. Without at least one matching entry, a signed manifest's signatures are reported as unverified (a warning), not failed — see `PackageValidator.validateSignatures`. */
  readonly pubkeySpecs?: readonly string[];
}

/**
 * Groups `PackageValidator`'s flat `ValidationIssue[]` into the five
 * named checks a caller of `xo verify` actually asks about (schema,
 * hashes, merkle root, required components, signature) plus an "other"
 * bucket for the rest (version, duplicate paths, capability
 * consistency, metadata) — a presentation grouping only; every issue
 * code and message still comes straight from `PackageValidator`, this
 * file does no validation of its own.
 */
const CHECKS: readonly { readonly label: string; readonly codes: readonly string[] }[] = [
  { label: 'schema', codes: ['SCHEMA_INVALID_MANIFEST', 'METADATA_INVALID'] },
  { label: 'hashes', codes: ['HASH_MISMATCH', 'COMPONENT_NOT_IN_MANIFEST'] },
  { label: 'merkle_root', codes: ['MERKLE_ROOT_MISMATCH'] },
  { label: 'required_components', codes: ['REQUIRED_COMPONENT_MISSING', 'MANDATORY_COMPONENT_ABSENT'] },
  { label: 'signature', codes: ['SIGNATURES_UNVERIFIED', 'SIGNATURE_INVALID'] },
];

function checklistLines(issues: readonly ValidationIssue[]): string[] {
  const byCode = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const existing = byCode.get(issue.code);
    if (existing) existing.push(issue);
    else byCode.set(issue.code, [issue]);
  }

  const covered = new Set(CHECKS.flatMap((c) => c.codes));
  const lines: string[] = [];
  for (const check of CHECKS) {
    const checkIssues = check.codes.flatMap((code) => byCode.get(code) ?? []);
    const failed = checkIssues.some((i) => i.severity === 'error');
    const warned = !failed && checkIssues.some((i) => i.severity === 'warning');
    const status = failed ? 'FAIL' : warned ? 'WARN' : 'PASS';
    lines.push(`[${status}] ${check.label}`);
  }
  const other = issues.filter((i) => !covered.has(i.code));
  if (other.length > 0) {
    const failed = other.some((i) => i.severity === 'error');
    lines.push(`[${failed ? 'FAIL' : 'WARN'}] other (version, duplicate paths, capability consistency)`);
  }
  return lines;
}

/** Exit code 0 means VALID, 1 means INVALID (or unreadable) — deliberately binary, so `xo verify some.xo || fail-the-build` works unmodified in a CI pipeline. */
export async function verifyCommand(options: VerifyOptions): Promise<CommandResult> {
  const publicKeys = new Map<string, string>();
  for (const spec of options.pubkeySpecs ?? []) {
    const eq = spec.indexOf('=');
    if (eq <= 0) return failWith(`invalid --pubkey "${spec}" — expected "<did>=<path/to/key.pem>"`);
    const did = spec.slice(0, eq);
    const keyPath = spec.slice(eq + 1);
    try {
      publicKeys.set(did, await readFile(keyPath, 'utf8'));
    } catch (cause) {
      return failWith(`could not read public key file "${keyPath}" for "${did}": ${(cause as Error).message}`);
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(options.archivePath));
  } catch (cause) {
    return failWith(`could not read "${options.archivePath}": ${(cause as Error).message}`);
  }

  const readResult = await unpackArchive(bytes);
  if (!readResult.ok) return failWith(readResult.error.message);

  // Only pass a resolver when the caller actually supplied --pubkey
  // entries. PackageValidator treats "no resolver at all" as "signatures
  // present but unverifiable — warn, don't fail" (SIGNATURES_UNVERIFIED),
  // vs. "resolver present but this DID isn't in it" as a hard
  // verification failure. An empty --pubkey list should behave like "I
  // didn't ask for signature verification", not like "I asked and it
  // failed" — so the resolver is omitted entirely rather than passed as
  // a function that always returns undefined.
  const validator = new PackageValidator(publicKeys.size > 0 ? { resolvePublicKey: (did) => publicKeys.get(did) } : {});
  const report = validator.validateAll(readResult.value);

  const lines = [
    ...checklistLines(report.issues),
    '',
    ...report.issues.map((issue) => `[${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`),
    report.valid ? 'VALID' : 'INVALID',
  ];

  return { exitCode: report.valid ? 0 : 1, lines };
}
