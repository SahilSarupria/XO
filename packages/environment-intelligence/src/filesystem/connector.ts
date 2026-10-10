import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@xo/types';
import type { AuthorizationDecision } from '../authorization.js';
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
import { extractIdentifiers, isSafeName } from './sanitize.js';
import { resolveInside, resolveRoot } from './scope-guard.js';

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
      'POSIX paths only; behaviour on Windows is untested',
      'Symlinks are never followed; they are counted and skipped',
      'Files whose names contain control or bidirectional-format characters are skipped',
      'Credential-like names (.env, *.pem, id_rsa, ...) and secret-store directories are excluded and only counted',
      'A path could change between check and read (TOCTOU); content reads use O_NOFOLLOW and re-verify the opened file is regular',
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

  private async authorize(
    ctx: ConnectorContext,
    operation: ConnectorOperation,
    permission: string,
    realRoot: string,
  ): Promise<Result<AuthorizationDecision, DiscoveryError>> {
    let decision: AuthorizationDecision;
    try {
      decision = await ctx.authorization.decide({
        connectorId: FILESYSTEM_CONNECTOR_ID,
        operation,
        permission,
        scope: { kind: 'path', path: realRoot },
        ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
        reason: `local filesystem ${operation} within the approved root`,
      });
    } catch (e) {
      return err(internalError(e, 'authorization gate'));
    }
    if (decision.effect === 'allow' && decision.authority !== 'none') return ok(decision);
    if (decision.effect === 'deny')
      return err(
        discoveryError(DiscoveryErrorCode.AUTHORIZATION_DENIED, 'authorization was denied', { permission, authority: decision.authority }),
      );
    return err(
      discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'authorization is required before this source can be read', {
        permission,
        authority: decision.authority,
      }),
    );
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
    decision: AuthorizationDecision,
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
        authority: decision.authority,
        decisionReason: decision.reason,
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
    const root = await resolveRoot(request.scope.root);
    if (!root.ok) return root;
    return ok(this.sourceFor(root.value, ctx));
  }

  async validateConnection(
    request: DiscoveryRequest<FilesystemScope>,
    ctx: ConnectorContext,
  ): Promise<Result<ConnectionValidation, DiscoveryError>> {
    const bad = this.checkRequest(request);
    if (bad !== undefined) return err(bad);
    if (ctx.signal?.aborted) return err(discoveryError(DiscoveryErrorCode.CANCELLED, 'cancelled before validation'));
    const root = await resolveRoot(request.scope.root);
    if (!root.ok) return root;
    const auth = await this.authorize(ctx, 'validate_connection', PERMISSION_LIST, root.value);
    if (!auth.ok) return auth;
    try {
      await readdir(root.value);
    } catch (e) {
      const errno = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null;
      return err(discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'approved root is not readable', { errno }));
    }
    const source = this.sourceFor(root.value, ctx);
    return ok({ sourceId: source.sourceId, validatedAt: ctx.clock.now().toISOString(), details: { readable: true } });
  }

  async discover(request: DiscoveryRequest<FilesystemScope>, ctx: ConnectorContext): Promise<Result<DiscoveryOutcome, DiscoveryError>> {
    const bad = this.checkRequest(request);
    if (bad !== undefined) return err(bad);
    if (ctx.signal?.aborted) return err(discoveryError(DiscoveryErrorCode.CANCELLED, 'cancelled before discovery'));
    const root = await resolveRoot(request.scope.root);
    if (!root.ok) return root;
    const realRoot = root.value;
    const auth = await this.authorize(ctx, 'discover', PERMISSION_LIST, realRoot);
    if (!auth.ok) return auth;

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

    const stack: { abs: string; rel: string; depth: number }[] = [{ abs: realRoot, rel: '', depth: 0 }];
    walk: while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) break;
      let names: string[];
      try {
        names = (await readdir(dir.abs)).sort();
      } catch (e) {
        addCount(skipped, 'unreadable_directory');
        if (dir.rel === '')
          return err(
            discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'approved root is not readable', {
              errno: typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null,
            }),
          );
        continue;
      }
      directories += 1;
      const subdirs: { abs: string; rel: string; depth: number }[] = [];
      for (const name of names) {
        if (ctx.signal?.aborted) {
          hit.add('cancelled');
          errors.push(discoveryError(DiscoveryErrorCode.CANCELLED, 'discovery cancelled; results are partial'));
          break walk;
        }
        if (elapsed(ctx, startMs) > limits.timeBudgetMs) {
          hit.add('time_budget');
          break walk;
        }
        if (visited >= limits.maxEntries) {
          hit.add('max_entries');
          break walk;
        }
        visited += 1;
        if (!isSafeName(name, limits.maxNameLength)) {
          addCount(skipped, 'unsafe_name');
          continue;
        }
        const abs = `${dir.abs}/${name}`;
        const rel = dir.rel === '' ? name : `${dir.rel}/${name}`;
        let st;
        try {
          st = await lstat(abs);
        } catch {
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
          if (dir.depth + 1 > limits.maxDepth) {
            hit.add('max_depth');
            addCount(skipped, 'depth_limit');
            continue;
          }
          subdirs.push({ abs, rel, depth: dir.depth + 1 });
          continue;
        }
        if (!st.isFile()) {
          addCount(skipped, 'not_regular_file');
          continue;
        }
        if (isSensitiveName(name, extraExcluded)) {
          addCount(skipped, 'excluded_sensitive_name');
          continue;
        }
        files.push({
          key: rel,
          name,
          extension: extname(name).toLowerCase(),
          sizeBytes: st.size,
          modifiedAt: st.mtime.toISOString(),
          depth: dir.depth,
        });
      }
      // Reverse so the stack pops directories in sorted order (deterministic traversal).
      for (let i = subdirs.length - 1; i >= 0; i -= 1) {
        const d = subdirs[i];
        if (d !== undefined) stack.push(d);
      }
    }

    files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const steps = (at: string): TransformationStep[] => [
      { step: 'fs.readdir+lstat', version: FILESYSTEM_CONNECTOR_VERSION, at },
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
        { fileCount: files.length, directoryCount: directories, totalBytes, extensionHistogram: histogram },
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
    const root = await resolveRoot(request.scope.root);
    if (!root.ok) return root;
    const realRoot = root.value;
    const source = this.sourceFor(realRoot, ctx);
    if (source.sourceId !== request.sourceId) {
      return err(
        discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'request names a different source than the approved scope', {
          reason: 'source_mismatch',
        }),
      );
    }
    const limits: FilesystemLimits = effectiveLimits(request.scope);
    if (request.resourceKeys.length > limits.maxContentFiles) {
      return err(
        discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'too many resources requested in one acquisition', {
          requested: request.resourceKeys.length,
          limit: limits.maxContentFiles,
        }),
      );
    }
    // Fail closed: validate EVERY key against the scope before reading ANY file, and before asking the gate.
    // Exclusion policy is applied to the whole path (not only the basename) and is identical to discovery's,
    // so a directly requested key under an excluded directory is never opened. Excluded keys are counted, not read.
    const extraExcludedForContent = new Set((request.scope.extraExcludedNames ?? []).map((n) => n.toLowerCase()));
    const resolved: { key: string; abs: string }[] = [];
    let excludedCount = 0;
    for (const key of request.resourceKeys) {
      const inside = await resolveInside(realRoot, key);
      if (!inside.ok) return inside;
      if (hasExcludedDirectorySegment(key, extraExcludedForContent)) {
        excludedCount += 1;
        continue;
      }
      resolved.push({ key, abs: inside.value });
    }
    const auth = await this.authorize(ctx, 'acquire_content', PERMISSION_READ, realRoot);
    if (!auth.ok) return auth;

    const startMs = ctx.clock.now().getTime();
    const skipped = new Map<string, number>();
    if (excludedCount > 0) skipped.set('excluded_directory', excludedCount);
    const hit = new Set<string>();
    const errors: DiscoveryError[] = [];
    const evidence: Evidence[] = [];
    let visited = 0;
    for (const { key, abs } of resolved) {
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
      let handle;
      try {
        handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (e) {
        const errno = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null;
        errors.push(discoveryError(DiscoveryErrorCode.SOURCE_UNAVAILABLE, 'resource could not be opened', { errno, resource: key }));
        continue;
      }
      try {
        // O_NOFOLLOW only protects the final component. Verify the actual
        // opened descriptor before reading so an intermediate symlink swap
        // cannot redirect this request into an excluded or aliased path.
        // Fail closed if this platform cannot expose descriptor realpaths.
        let openedPath: string;
        try {
          openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
        } catch {
          errors.push(discoveryError(DiscoveryErrorCode.SOURCE_UNAVAILABLE, 'opened resource path could not be verified safely', {
            reason: 'descriptor_path_unavailable',
            resource: key,
          }));
          continue;
        }
        if (openedPath !== abs) {
          addCount(skipped, 'symlink_not_followed');
          continue;
        }
        const st = await handle.stat();
        if (!st.isFile()) {
          addCount(skipped, 'not_regular_file');
          continue;
        }
        const toRead = Math.min(st.size, limits.maxContentBytes);
        const buffer = Buffer.alloc(toRead);
        const { bytesRead } = toRead > 0 ? await handle.read(buffer, 0, toRead, 0) : { bytesRead: 0 };
        const bytes = buffer.subarray(0, bytesRead);
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
          { step: 'fs.open(O_NOFOLLOW)+read(bounded)', version: FILESYSTEM_CONNECTOR_VERSION, at },
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
        await handle.close();
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
  }
}
