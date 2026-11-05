import type { DiscoveryScopeBase } from '../connector.js';

/**
 * Scope of ONE filesystem discovery: exactly one approved root directory.
 * Several roots means several requests, so each root is its own source with
 * its own authorization decision and its own state in the inventory.
 */
export interface FilesystemScope extends DiscoveryScopeBase {
  readonly kind: 'filesystem_root';
  /** Absolute path of the approved directory. Not a filesystem root, not the home directory. */
  readonly root: string;
  readonly limits?: Partial<FilesystemLimits>;
  /** Extra directory/file NAMES to exclude, in addition to the built-in sensitive-name rules. */
  readonly extraExcludedNames?: readonly string[];
  /**
   * C7, additive. The source-relative keys the caller has chosen to include. REQUIRED by `incrementalSync` (a sync with no chosen
   * items is refused, never read as "everything"); ignored by discovery and by `acquireContent`, which take their keys per request.
   * Because the connector is told what is in scope, a chosen item that no longer exists can be reported as deleted without the
   * connector keeping any state of its own.
   */
  readonly includeKeys?: readonly string[];
  /**
   * C7, additive, OFF by default. When true, a chosen `.json` file that is a structured record file
   * (`{"schema":"ei.org-record.v1","records":[...]}`, at most 200 plain-object records, shallow, whole file read) also carries those records
   * in its content evidence, so the shipped structured-record deriver can turn them into knowledge. Nothing else about a file's content is
   * ever retained: free text, and JSON that is not a record file, still yield only a digest, a length and strict business tokens.
   */
  readonly structuredRecords?: boolean;
}

export interface FilesystemLimits {
  /** Directory depth below the root that will be descended into (root = depth 0). */
  readonly maxDepth: number;
  /** Total directory entries examined in one pass. */
  readonly maxEntries: number;
  /** Bytes read from any single file during content acquisition (prefix only beyond this). */
  readonly maxContentBytes: number;
  /** Files read in one content acquisition request. */
  readonly maxContentFiles: number;
  /** Wall-clock budget (injected clock) for one operation. */
  readonly timeBudgetMs: number;
  readonly maxNameLength: number;
}

export const DEFAULT_FILESYSTEM_LIMITS: FilesystemLimits = Object.freeze({
  maxDepth: 6,
  maxEntries: 5_000,
  maxContentBytes: 256 * 1024,
  maxContentFiles: 200,
  timeBudgetMs: 10_000,
  maxNameLength: 200,
});

export function effectiveLimits(scope: FilesystemScope): FilesystemLimits {
  return { ...DEFAULT_FILESYSTEM_LIMITS, ...(scope.limits ?? {}) };
}

/** Only text-like formats are read. Everything else gets metadata only, never content. */
export const CONTENT_EXTENSIONS: ReadonlySet<string> = new Set(['.txt', '.md', '.csv', '.tsv', '.json']);

/** Directory names never descended into (secret stores, VCS internals, dependency trees). */
export const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
]);

/** File-name patterns treated as credential material. Matched files are counted, never listed or read. */
export const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|kdbx|keystore|jks|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|netrc|pgpass|git-credentials|pypirc)$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /cookies?(\..*)?$/i,
];
