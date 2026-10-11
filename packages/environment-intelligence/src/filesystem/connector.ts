import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@xo/types';
import { requireAuthorization, type TrustedAllow } from '../authorization-gate.js';
import type {
  AcquisitionOutcome,
  AcquisitionRequest,
  ConnectionValidation,
  Connector,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorOperation,
  DetectedSource,
  DiscoveryOutcome,
  DiscoveryRequest,
  LimitReport,
} from '../connector.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from '../errors.js';
import type { Evidence, EvidenceKind, JsonValue, TransformationStep } from '../evidence.js';
import { ConnectorId, EvidenceId, SourceId, stableDigest, stableId } from '../ids.js';
import {
  CONTENT_EXTENSIONS,
  EXCLUDED_DIRECTORY_NAMES,
  SENSITIVE_FILE_PATTERNS,
  effectiveLimits,
  type FilesystemLimits,
  type FilesystemScope,
} from './config.js';
import type { BigIntStats } from 'node:fs';
import {
  AnchoredTree,
  FdWalkFatal,
  NODE_FS_OPS,
  errnoCode,
  type DirNode,
  type FsOps,
  type InternalConnectorOptions,
  type SkipReason,
} from './fd-walk.js';
import { extractIdentifiers, isSafeName } from './sanitize.js';
import { resolveRoot, validateKeyLexically, validateRootLexically } from './scope-guard.js';

export const FILESYSTEM_CONNECTOR_ID = ConnectorId('xo.connector.local-filesystem');
export const FILESYSTEM_CONNECTOR_VERSION = '0.1.0';

const PERMISSION_LIST = 'filesystem.list';
const PERMISSION_READ = 'filesystem.read';

const DESCRIPTOR: ConnectorDescriptor = {
  id: FILESYSTEM_CONNECTOR_ID,
  version: FILESYSTEM_CONNECTOR_VERSION,
  displayName: 'Local filesystem (explicitly scoped, read-only)',
  sourceTypes: ['local_filesystem'],
  authMethods: ['operator_scope_grant'],
  configFields: [
    { name: 'root', description: 'Absolute path of the one directory approved for discovery.', required: true, secret: false },
  ],
  requiredPermissions: { validate_connection: PERMISSION_LIST, discover: PERMISSION_LIST, acquire_content: PERMISSION_READ },
  operations: {
    detect: 'supported',
    validate_connection: 'supported',
    discover: 'supported',
    acquire_content: 'supported',
    incremental_sync: 'unsupported',
    health: 'unsupported',
  },
  evidenceKinds: ['resource_inventory', 'metadata', 'document_content'],
  sideEffects: 'none',
  documentation: {
    scope: 'Exactly one approved directory tree on the machine where the connector runs. Nothing outside it is listed or read.',
    detects: [
      'That the approved directory exists and is readable',
      'Regular files beneath it: relative path, size, modified time, extension',
      'For text-like files (.txt .md .csv .tsv .json) with separate read permission: a SHA-256 digest of the (bounded) content and business-identifier tokens such as INV-1042',
    ],
    cannotDetermine: [
      'Which applications, accounts, or remote services the organization uses (a directory listing does not reveal them)',
      'What any file means, who authored it, or whether its content is accurate',
      'Anything about files that were excluded, symlinked, too deep, or beyond the entry limit',
      'Document structure of binary formats such as PDF (not parsed; metadata only)',
    ],
    limitations: [
      'POSIX paths only; behaviour on Windows is untested, and content acquisition on Windows is explicitly refused',
      'On Linux, discovery and content acquisition walk the tree through held directory descriptors (/proc/self/fd) and refuse mount and device boundaries; if that cannot be established, acquisition fails closed and Linux discovery fails closed',
      'On other platforms discovery uses the earlier path-based walk and is labelled path_based_unhardened (traversal and hardened:false) in its evidence; content acquisition is refused there and never falls back to a path-based read',
      'Ordinary symlinks are skipped; acquisition rejects symlinks in every path component',
      'Regular files with more than one hard link are skipped (hard_linked_file) in discovery and acquisition: their other links may lie outside the approved tree and link count cannot show where; a link added after the final check can still race',
      'Files whose names contain control or bidirectional-format characters are skipped',
      'Credential-like names (.env, *.pem, id_rsa, ...) and secret-store directories are excluded and only counted',
      'Descriptor anchoring is NOT openat2(RESOLVE_BENEATH) and does not give complete race-free containment: the root or an ancestor swapped before the root is opened, an entry swapped between lstat and open (it stays beneath its held parent), a held directory renamed out of the root, and a mount created after the mountinfo snapshot remain possible for a hostile process with write access to the approved tree',
      'Passive: performs no writes, no network access, and executes nothing it reads',
    ],
  },
};
Object.freeze(DESCRIPTOR);

function elapsed(ctx: ConnectorContext, startMs: number): number {
  return ctx.clock.now().getTime() - startMs;
}

function addCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toSkipped(map: ReadonlyMap<string, number>): { readonly byReason: Readonly<Record<string, number>> } {
  const byReason: Record<string, number> = {};
  for (const key of [...map.keys()].sort()) byReason[key] = map.get(key) ?? 0;
  return { byReason };
}

function isSensitiveName(name: string, extra: ReadonlySet<string>): boolean {
  const lower = name.toLowerCase();
  return extra.has(lower) || SENSITIVE_FILE_PATTERNS.some((re) => re.test(name));
}

/** The single directory-exclusion rule, shared by discovery and acquisition. Names are compared case-insensitively. */
function isExcludedDirectoryName(name: string, extra: ReadonlySet<string>): boolean {
  const lower = name.toLowerCase();
  return EXCLUDED_DIRECTORY_NAMES.has(lower) || extra.has(lower);
}

/** True when ANY directory segment of a source-relative key (every segment except the last) is excluded. */
function hasExcludedDirectorySegment(resourceKey: string, extra: ReadonlySet<string>): boolean {
  return resourceKey
    .split('/')
    .slice(0, -1)
    .some((segment) => isExcludedDirectoryName(segment, extra));
}

interface FileMeta {
  readonly key: string;
  readonly name: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly depth: number;
}

export class LocalFilesystemConnector implements Connector<FilesystemScope> {
  readonly descriptor: ConnectorDescriptor = DESCRIPTOR;

  private readonly ops: FsOps;
  private readonly fdBudget: number | undefined;

  /** @param internal Not part of the public contract: a test seam and tuning knobs (see `fd-walk.ts`). */
  constructor(internal?: InternalConnectorOptions) {
    this.ops = internal?.fsOps ?? NODE_FS_OPS;
    this.fdBudget = internal?.fdBudget;
  }

  private async authorize(
    ctx: ConnectorContext,
    operation: ConnectorOperation,
    permission: string,
    realRoot: string,
  ): Promise<Result<TrustedAllow, DiscoveryError>> {
    return requireAuthorization(ctx.authorization, {
      connectorId: FILESYSTEM_CONNECTOR_ID,
      operation,
      permission,
      scope: { kind: 'path', path: realRoot },
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      reason: `local filesystem ${operation} within the approved root`,
    });
  }

  /**
   * The ONLY way an operation obtains a usable root. Order is the security
   * property:
   *   1. pure string validation of the caller's root (no filesystem access);
   *   2. an authorization decision for exactly that lexical path;
   *   3. only then resolve the real path (the first filesystem access);
   *   4. if the real path differs from the lexical one (a symlink in the
   *      path), a SEPARATE decision for the real path before anything is
   *      listed or read.
   * A denied or unauthenticated request therefore never causes the requested
   * path to be probed, and learns nothing about whether it exists or what it
   * is. Decisions are never cached or reused across operations or paths.
   * Consequence for `once`-lifetime grants: each operation (detect, validate_connection, discover or
   * acquire_content) consumes its own allow, and a symlinked root consumes two (lexical, then real path), so a
   * single `once` allow authorizes only one operation. This is intentional; grant semantics are unchanged.
   */
  private async authorizeRoot(
    ctx: ConnectorContext,
    operation: ConnectorOperation,
    permission: string,
    requestedRoot: string,
  ): Promise<Result<{ readonly realRoot: string; readonly allow: TrustedAllow }, DiscoveryError>> {
    const lexical = validateRootLexically(requestedRoot);
    if (!lexical.ok) return lexical;
    const first = await this.authorize(ctx, operation, permission, lexical.value);
    if (!first.ok) return first;
    const resolved = await resolveRoot(lexical.value);
    if (!resolved.ok) return resolved;
    if (resolved.value === lexical.value) return ok({ realRoot: resolved.value, allow: first.value });
    const second = await this.authorize(ctx, operation, permission, resolved.value);
    if (!second.ok) return second;
    return ok({ realRoot: resolved.value, allow: second.value });
  }

  private sourceFor(realRoot: string, ctx: ConnectorContext): DetectedSource {
    const sourceId = SourceId(stableId('src', ['local_filesystem', realRoot]));
    return {
      sourceId,
      sourceType: 'local_filesystem',
      displayName: realRoot.split('/').filter(Boolean).pop() ?? realRoot,
      locator: realRoot,
      detectedBy: FILESYSTEM_CONNECTOR_ID,
      detectedAt: ctx.clock.now().toISOString(),
      fingerprint: stableDigest(['local_filesystem', 'directory', realRoot]),
    };
  }

  private checkRequest(request: { readonly sourceType: string; readonly scope: { readonly kind: string } }): DiscoveryError | undefined {
    if (request.sourceType !== 'local_filesystem') {
      return discoveryError(
        DiscoveryErrorCode.UNSUPPORTED_SOURCE,
        `connector ${FILESYSTEM_CONNECTOR_ID} does not support source type "${request.sourceType}"`,
        { sourceType: request.sourceType },
      );
    }
    if (request.scope.kind !== 'filesystem_root') {
      return discoveryError(DiscoveryErrorCode.INVALID_SCOPE, 'scope.kind must be "filesystem_root"', { kind: request.scope.kind });
    }
    return undefined;
  }

  private provenance(
    source: DetectedSource,
    locator: string,
    operation: ConnectorOperation,
    permission: string,
    allow: TrustedAllow,
    ctx: ConnectorContext,
    steps: readonly TransformationStep[],
  ): Evidence['provenance'] {
    return {
      sourceId: source.sourceId,
      connectorId: FILESYSTEM_CONNECTOR_ID,
      connectorVersion: FILESYSTEM_CONNECTOR_VERSION,
      locator,
      observedAt: ctx.clock.now().toISOString(),
      access: {
        operation,
        permission,
        authority: allow.authority,
        decisionReason: allow.decision.reason,
        ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      },
      transformationChain: steps,
    };
  }

  private makeEvidence(
    kind: EvidenceKind,
    source: DetectedSource,
    resourceKey: string,
    payload: { readonly [key: string]: JsonValue },
    sensitivity: Evidence['sensitivity'],
    provenance: Evidence['provenance'],
  ): Evidence {
    // The id excludes observation time so an unchanged resource keeps its id across scans.
    const id = EvidenceId(stableId('ev', [source.sourceId, kind, resourceKey, JSON.stringify(payload)]));
    return Object.freeze({ id, kind, sourceId: source.sourceId, resourceKey, payload, sensitivity, provenance });
  }

  async detectSource(request: DiscoveryRequest<FilesystemScope>, ctx: ConnectorContext): Promise<Result<DetectedSource, DiscoveryError>> {
    const bad = this.checkRequest(request);
    if (bad !== undefined) return err(bad);
    const root = await this.authorizeRoot(ctx, 'detect', PERMISSION_LIST, request.scope.root);
    if (!root.ok) return root;
    return ok(this.sourceFor(root.value.realRoot, ctx));
  }

  async validateConnection(
    request: DiscoveryRequest<FilesystemScope>,
    ctx: ConnectorContext,
  ): Promise<Result<ConnectionValidation, DiscoveryError>> {
    const bad = this.checkRequest(request);
    if (bad !== undefined) return err(bad);
    if (ctx.signal?.aborted) return err(discoveryError(DiscoveryErrorCode.CANCELLED, 'cancelled before validation'));
    const root = await this.authorizeRoot(ctx, 'validate_connection', PERMISSION_LIST, request.scope.root);
    if (!root.ok) return root;
    try {
      await this.ops.readdir(root.value.realRoot);
    } catch (e) {
      const errno = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null;
      return err(discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'approved root is not readable', { errno }));
    }
    const source = this.sourceFor(root.value.realRoot, ctx);
    return ok({ sourceId: source.sourceId, validatedAt: ctx.clock.now().toISOString(), details: { readable: true } });
  }

  async discover(request: DiscoveryRequest<FilesystemScope>, ctx: ConnectorContext): Promise<Result<DiscoveryOutcome, DiscoveryError>> {
    const bad = this.checkRequest(request);
    if (bad !== undefined) return err(bad);
    if (ctx.signal?.aborted) return err(discoveryError(DiscoveryErrorCode.CANCELLED, 'cancelled before discovery'));
    const root = await this.authorizeRoot(ctx, 'discover', PERMISSION_LIST, request.scope.root);
    if (!root.ok) return root;
    const realRoot = root.value.realRoot;
    const auth = { value: root.value.allow };

    const limits = effectiveLimits(request.scope);
    const extraExcluded = new Set((request.scope.extraExcludedNames ?? []).map((n) => n.toLowerCase()));
    const source = this.sourceFor(realRoot, ctx);
    const startMs = ctx.clock.now().getTime();
    const skipped = new Map<string, number>();
    const hit = new Set<string>();
    const errors: DiscoveryError[] = [];
    const files: FileMeta[] = [];
    let visited = 0;
    let directories = 0;

    // D1: on Linux the walk is descriptor-anchored (F1) and FAILS CLOSED if that cannot be established. On other
    // platforms the previous path-based walk is kept and is explicitly labelled unhardened in the evidence.
    const hardened = this.ops.platform === 'linux';
    const traversal = hardened ? 'fd_anchored' : 'path_based_unhardened';
    let tree: AnchoredTree | undefined;
    type Dir = { readonly abs: string; readonly node?: DirNode };
    const list = (d: Dir): Promise<string[]> => (tree !== undefined && d.node !== undefined ? tree.list(d.node) : this.ops.readdir(d.abs));
    const lstatEntry = (d: Dir, name: string) =>
      tree !== undefined && d.node !== undefined ? tree.lstatChild(d.node, name) : this.ops.lstat(`${d.abs}/${name}`);
    const descend = async (d: Dir, name: string, st: BigIntStats): Promise<{ dir: Dir } | { skip: SkipReason }> => {
      if (tree === undefined || d.node === undefined) return { dir: { abs: `${d.abs}/${name}` } };
      const child = await tree.openChildDir(d.node, name, st, ctx.signal);
      return child.kind === 'dir' ? { dir: { abs: child.node.abs, node: child.node } } : { skip: child.reason };
    };
    const skipLabel = (r: SkipReason): string => (r === 'missing' ? 'unreadable_entry' : r === 'not_a_directory' ? 'entry_changed' : r);

    /** Returns true when a limit or cancellation stopped the whole walk. */
    const walkDir = async (dir: Dir, rel: string, depth: number): Promise<boolean> => {
      let names: string[];
      try {
        names = (await list(dir)).sort();
      } catch (e) {
        if (e instanceof FdWalkFatal) throw e;
        addCount(skipped, 'unreadable_directory');
        if (rel === '')
          throw new FdWalkFatal(
            discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'approved root is not readable', { errno: errnoCode(e) }),
          );
        return false;
      }
      directories += 1;
      const subdirs: { name: string; rel: string; st: BigIntStats }[] = [];
      for (const name of names) {
        if (ctx.signal?.aborted) {
          hit.add('cancelled');
          errors.push(discoveryError(DiscoveryErrorCode.CANCELLED, 'discovery cancelled; results are partial'));
          return true;
        }
        if (elapsed(ctx, startMs) > limits.timeBudgetMs) {
          hit.add('time_budget');
          return true;
        }
        if (visited >= limits.maxEntries) {
          hit.add('max_entries');
          return true;
        }
        visited += 1;
        if (!isSafeName(name, limits.maxNameLength)) {
          addCount(skipped, 'unsafe_name');
          continue;
        }
        const entryRel = rel === '' ? name : `${rel}/${name}`;
        let st: BigIntStats;
        try {
          st = await lstatEntry(dir, name);
        } catch (e) {
          if (e instanceof FdWalkFatal) throw e;
          addCount(skipped, 'unreadable_entry');
          continue;
        }
        if (st.isSymbolicLink()) {
          addCount(skipped, 'symlink_not_followed');
          continue;
        }
        if (st.isDirectory()) {
          if (isExcludedDirectoryName(name, extraExcluded)) {
            addCount(skipped, 'excluded_directory');
            continue;
          }
          if (depth + 1 > limits.maxDepth) {
            hit.add('max_depth');
            addCount(skipped, 'depth_limit');
            continue;
          }
          subdirs.push({ name, rel: entryRel, st });
          continue;
        }
        if (!st.isFile()) {
          addCount(skipped, 'not_regular_file');
          continue;
        }
        // F5: a regular file with more than one hard link may be reachable (and writable) through paths outside the
        // approved tree, so it is neither inventoried nor acquirable. Counted only; no path, count or inode is reported.
        if (st.nlink > 1n) {
          addCount(skipped, 'hard_linked_file');
          continue;
        }
        // Mount/device boundary applies to file entries too: their metadata must not describe another filesystem.
        if (tree !== undefined && (tree.isOtherDevice(st) || tree.isNestedMount(`${dir.abs}/${name}`))) {
          addCount(skipped, 'mount_boundary');
          continue;
        }
        if (isSensitiveName(name, extraExcluded)) {
          addCount(skipped, 'excluded_sensitive_name');
          continue;
        }
        files.push({
          key: entryRel,
          name,
          extension: extname(name).toLowerCase(),
          sizeBytes: Number(st.size),
          modifiedAt: st.mtime.toISOString(),
          depth,
        });
      }
      // Subdirectories in sorted order, each fully walked before the next sibling (deterministic preorder).
      for (const sub of subdirs) {
        let r: { dir: Dir } | { skip: SkipReason };
        try {
          r = await descend(dir, sub.name, sub.st);
        } catch (e) {
          if (e instanceof FdWalkFatal && e.error.code === DiscoveryErrorCode.CANCELLED) {
            hit.add('cancelled');
            errors.push(discoveryError(DiscoveryErrorCode.CANCELLED, 'discovery cancelled; results are partial'));
            return true;
          }
          throw e;
        }
        if ('skip' in r) {
          addCount(skipped, skipLabel(r.skip));
          continue;
        }
        try {
          if (await walkDir(r.dir, sub.rel, depth + 1)) return true;
        } finally {
          if (tree !== undefined && r.dir.node !== undefined) await tree.release(r.dir.node);
        }
      }
      return false;
    };

    try {
      if (hardened) tree = await AnchoredTree.open(this.ops, realRoot, this.fdBudget);
      await walkDir(tree !== undefined ? { abs: realRoot, node: tree.root } : { abs: realRoot }, '', 0);
    } catch (e) {
      if (e instanceof FdWalkFatal) return err(e.error);
      return err(internalError(e, 'discovery walk'));
    } finally {
      await tree?.close();
    }

    files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const steps = (at: string): TransformationStep[] => [
      {
        step: hardened ? 'fs.fd_walk(readdir+lstat+fstat,O_NOFOLLOW,mount_checks)' : 'fs.readdir+lstat(path_based_unhardened)',
        version: FILESYSTEM_CONNECTOR_VERSION,
        at,
      },
      { step: 'normalize.resource_inventory', version: FILESYSTEM_CONNECTOR_VERSION, at },
    ];
    const at = ctx.clock.now().toISOString();
    const evidence: Evidence[] = [];
    const extensionCounts = new Map<string, number>();
    let totalBytes = 0;
    for (const f of files) {
      totalBytes += f.sizeBytes;
      addCount(extensionCounts, f.extension === '' ? '(none)' : f.extension);
      const contentAcquirable = CONTENT_EXTENSIONS.has(f.extension);
      evidence.push(
        this.makeEvidence(
          'resource_inventory',
          source,
          f.key,
          {
            relativePath: f.key,
            name: f.name,
            extension: f.extension,
            sizeBytes: f.sizeBytes,
            modifiedAt: f.modifiedAt,
            depth: f.depth,
            contentAcquirable,
          },
          'metadata',
          this.provenance(source, f.key, 'discover', PERMISSION_LIST, auth.value, ctx, steps(at)),
        ),
      );
    }
    const histogram: Record<string, number> = {};
    for (const k of [...extensionCounts.keys()].sort()) histogram[k] = extensionCounts.get(k) ?? 0;
    evidence.push(
      this.makeEvidence(
        'metadata',
        source,
        '',
        { fileCount: files.length, directoryCount: directories, totalBytes, extensionHistogram: histogram, traversal, hardened },
        'metadata',
        this.provenance(source, '', 'discover', PERMISSION_LIST, auth.value, ctx, steps(at)),
      ),
    );

    const contentFingerprint = stableDigest(files.map((f) => `${f.key}|${f.sizeBytes}|${f.modifiedAt}`));
    const limitsReport: LimitReport = { hit: [...hit].sort(), entriesVisited: visited, elapsedMs: elapsed(ctx, startMs) };
    const partial = hit.size > 0 || errors.length > 0;
    return ok({
      status: partial ? 'partial' : 'complete',
      sources: [source],
      scans: [{ sourceId: source.sourceId, contentFingerprint }],
      evidence,
      skipped: toSkipped(skipped),
      limits: limitsReport,
      errors,
    });
  }

  async acquireContent(
    request: AcquisitionRequest & { readonly scope: FilesystemScope },
    ctx: ConnectorContext,
  ): Promise<Result<AcquisitionOutcome, DiscoveryError>> {
    if (request.scope.kind !== 'filesystem_root')
      return err(discoveryError(DiscoveryErrorCode.INVALID_SCOPE, 'scope.kind must be "filesystem_root"', { kind: request.scope.kind }));
    if (request.kind !== 'document_content') {
      return err(
        discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, `evidence kind "${request.kind}" cannot be acquired by this connector`, {
          kind: request.kind,
        }),
      );
    }
    if (ctx.signal?.aborted) return err(discoveryError(DiscoveryErrorCode.CANCELLED, 'cancelled before acquisition'));
    const limits: FilesystemLimits = effectiveLimits(request.scope);
    if (request.resourceKeys.length > limits.maxContentFiles) {
      return err(
        discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'too many resources requested in one acquisition', {
          requested: request.resourceKeys.length,
          limit: limits.maxContentFiles,
        }),
      );
    }
    // Step 1 - PURE string checks only (no filesystem access, so they are safe before authorization):
    // key shape, and the exclusion policy applied to every directory segment (identical to discovery's).
    // Excluded keys are never opened; they are counted.
    const extraExcludedForContent = new Set((request.scope.extraExcludedNames ?? []).map((n) => n.toLowerCase()));
    const permittedKeys: string[] = [];
    let excludedCount = 0;
    for (const key of request.resourceKeys) {
      const lexical = validateKeyLexically(key);
      if (!lexical.ok) return lexical;
      if (hasExcludedDirectorySegment(key, extraExcludedForContent)) {
        excludedCount += 1;
        continue;
      }
      permittedKeys.push(key);
    }
    // Step 2 - authorization (read permission) for the lexical root, then for the real root if it differs.
    // The root is not resolved, and no key is touched on disk, before this succeeds.
    const root = await this.authorizeRoot(ctx, 'acquire_content', PERMISSION_READ, request.scope.root);
    if (!root.ok) return root;
    const realRoot = root.value.realRoot;
    const auth = { value: root.value.allow };
    const source = this.sourceFor(realRoot, ctx);
    if (source.sourceId !== request.sourceId) {
      return err(
        discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'request names a different source than the approved scope', {
          reason: 'source_mismatch',
        }),
      );
    }
    // Step 3 - only now touch the filesystem. Hardened content acquisition REQUIRES descriptor-anchored traversal
    // (F1): if /proc/self/fd, mountinfo or the anchor cannot be established it fails closed - there is no
    // path-based fallback. Fail closed also means EVERY key is verified before ANY file is read.
    let tree: AnchoredTree;
    try {
      tree = await AnchoredTree.open(this.ops, realRoot, this.fdBudget);
    } catch (e) {
      if (e instanceof FdWalkFatal) return err(e.error);
      return err(internalError(e, 'acquisition anchor'));
    }
    try {
      const resolved: { key: string; segments: readonly string[] }[] = [];
      for (const key of permittedKeys) {
        const lexical = validateKeyLexically(key);
        if (!lexical.ok) return lexical;
        const inside = await tree.verifyKey(lexical.value, ctx.signal);
        if (!inside.ok) return inside;
        resolved.push({ key, segments: lexical.value });
      }

      const startMs = ctx.clock.now().getTime();
      const skipped = new Map<string, number>();
      if (excludedCount > 0) skipped.set('excluded_directory', excludedCount);
      const hit = new Set<string>();
      const errors: DiscoveryError[] = [];
      const evidence: Evidence[] = [];
      let visited = 0;
      for (const { key, segments } of resolved) {
        if (ctx.signal?.aborted) {
          hit.add('cancelled');
          errors.push(discoveryError(DiscoveryErrorCode.CANCELLED, 'acquisition cancelled; results are partial'));
          break;
        }
        if (elapsed(ctx, startMs) > limits.timeBudgetMs) {
          hit.add('time_budget');
          break;
        }
        visited += 1;
        const name = key.split('/').pop() ?? key;
        if (isSensitiveName(name, extraExcludedForContent)) {
          addCount(skipped, 'excluded_sensitive_name');
          continue;
        }
        if (!CONTENT_EXTENSIONS.has(extname(key).toLowerCase())) {
          addCount(skipped, 'content_type_not_allowed');
          continue;
        }
        let opened: Awaited<ReturnType<AnchoredTree['openFileForKey']>>;
        try {
          opened = await tree.openFileForKey(segments, ctx.signal);
        } catch (e) {
          if (e instanceof FdWalkFatal && e.error.code === DiscoveryErrorCode.CANCELLED) {
            hit.add('cancelled');
            errors.push(discoveryError(DiscoveryErrorCode.CANCELLED, 'acquisition cancelled; results are partial'));
            break;
          }
          throw e;
        }
        if (!opened.ok) {
          const why = opened.error.context['reason'];
          if (why === 'not_regular_file' || why === 'hard_linked_file' || why === 'entry_changed') {
            addCount(skipped, why);
            continue;
          }
          errors.push(discoveryError(opened.error.code, opened.error.message, { ...opened.error.context, resource: key }));
          continue;
        }
        const handle = opened.value;
        try {
          const st = await handle.stat();
          if (!st.isFile()) {
            addCount(skipped, 'not_regular_file');
            continue;
          }
          const beforeRead = await handle.stat({ bigint: true });
          const toRead = Math.min(st.size, limits.maxContentBytes);
          const buffer = Buffer.alloc(toRead);
          const { bytesRead } = toRead > 0 ? await handle.read(buffer, 0, toRead, 0) : { bytesRead: 0 };
          const bytes = buffer.subarray(0, bytesRead);
          // F5: re-check identity and link count on the SAME descriptor after the read; a link added (or the inode
          // replaced) while we were reading means the boundary no longer holds, so the content is discarded.
          const post = await handle.stat({ bigint: true });
          if (post.nlink > 1n || post.ino !== beforeRead.ino || post.dev !== beforeRead.dev) {
            addCount(skipped, post.nlink > 1n ? 'hard_linked_file' : 'entry_changed');
            continue;
          }
          const truncated = st.size > bytesRead;
          const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          let encoding: 'utf8' | 'binary_or_invalid' = 'utf8';
          let identifiers: readonly string[] = [];
          let identifiersTruncated = false;
          if (bytes.includes(0)) {
            encoding = 'binary_or_invalid';
          } else {
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
              const found = extractIdentifiers(text);
              identifiers = found.identifiers;
              identifiersTruncated = found.truncated;
            } catch {
              encoding = 'binary_or_invalid';
            }
          }
          if (encoding === 'binary_or_invalid') {
            errors.push(
              discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'content is not valid UTF-8 text; digest recorded, no tokens extracted', {
                reason: 'invalid_utf8_or_binary',
                resource: key,
              }),
            );
          }
          const at = ctx.clock.now().toISOString();
          const steps: TransformationStep[] = [
            {
              step: 'fs.fd_walk(lstat regular-file check, open O_NONBLOCK|O_NOFOLLOW relative to held descriptor, fstat regular-file check)+read(bounded)',
              version: FILESYSTEM_CONNECTOR_VERSION,
              at,
            },
            { step: 'derive.sha256+identifier_tokens', version: FILESYSTEM_CONNECTOR_VERSION, at },
          ];
          evidence.push(
            this.makeEvidence(
              'document_content',
              source,
              key,
              {
                digest,
                digestCoversWholeFile: !truncated,
                byteLength: bytesRead,
                fileSizeBytes: st.size,
                truncated,
                encoding,
                identifiers: [...identifiers],
                identifiersTruncated,
              },
              'derived_from_content',
              this.provenance(source, key, 'acquire_content', PERMISSION_READ, auth.value, ctx, steps),
            ),
          );
        } catch (e) {
          errors.push(internalError(e, 'content read'));
        } finally {
          await tree.closeHandle(handle);
        }
      }
      const partial = hit.size > 0 || errors.length > 0;
      return ok({
        status: partial ? 'partial' : 'complete',
        evidence,
        skipped: toSkipped(skipped),
        limits: { hit: [...hit].sort(), entriesVisited: visited, elapsedMs: elapsed(ctx, startMs) },
        errors,
      });
    } catch (e) {
      if (e instanceof FdWalkFatal) return err(e.error);
      return err(internalError(e, 'content acquisition'));
    } finally {
      await tree.close();
    }
  }
}
