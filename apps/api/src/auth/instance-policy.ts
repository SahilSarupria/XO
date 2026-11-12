import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ErrorCode, XoError } from '@xo/errors';
import {
  PERMISSION_DOMAINS,
  PRINCIPAL_KINDS,
  RuleBasedPolicy,
  parsePermissionId,
  type PermissionPolicy,
  type PermissionRequest,
  type PolicyRule,
  type PolicyRuleMatch,
} from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';

/**
 * UW-1 (ADR 0010) — the instance's persisted operator policy: which principals hold which non-workspace permissions (procedures,
 * effects, audit, capabilities), and which principals or permissions are suspended. Before this, the shipped entrypoint ran with an
 * empty policy and there was no way to grant, say, `procedure.execute` without changing code.
 *
 * Storage: one JSON document, `<WORKSPACE_DATA_DIR>/_instance/policy.json`, written atomically (temp file + rename) by the operator
 * script `scripts/manage-policy.ts`. Like API keys, it is operator-managed; no route edits it.
 *
 * Safety:
 *  - Strict schema: only `ALLOW` / `DENY`, only the match keys listed in {@link ALLOWED_MATCH_KEYS}, every value validated. An unknown
 *    key or value rejects the whole document.
 *  - Fail closed: a missing file means "no operator rules"; an unreadable or invalid file ALSO means no operator ALLOW takes effect, and
 *    `lastError` says why. Workspace roles are unaffected (they are a separate ceiling, ADR 0010), so a broken file cannot widen access.
 *  - Workspace operations cannot be granted here (roles decide them); a rule matching the `workspace` domain may only `DENY`.
 */

export const INSTANCE_POLICY_FORMAT = 1;
const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const ROLE = /^[a-z][a-z0-9-]{0,31}$/;
const CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_MATCH_KEYS: ReadonlySet<string> = new Set(['permission', 'domain', 'principalId', 'principalKind', 'role', 'capabilityId']);
const MAX_RULES = 10_000;

export interface InstancePolicyDocument {
  readonly format: typeof INSTANCE_POLICY_FORMAT;
  /** Incremented on every write; lets the operator script refuse to overwrite a concurrent change. */
  readonly revision: number;
  readonly rules: readonly PolicyRule[];
}

function bad(message: string): XoError {
  return new XoError(ErrorCode.INVALID_ARGUMENT, `invalid instance policy: ${message}`);
}

function parseMatch(raw: unknown, where: string): Result<PolicyRuleMatch, XoError> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err(bad(`${where}.match must be an object`));
  const m = raw as Record<string, unknown>;
  for (const key of Object.keys(m)) if (!ALLOWED_MATCH_KEYS.has(key)) return err(bad(`${where}.match has unknown field "${key}"`));
  const out: Record<string, unknown> = {};
  if (m['permission'] !== undefined) {
    if (typeof m['permission'] !== 'string' || !parsePermissionId(m['permission']).ok)
      return err(bad(`${where}.match.permission is not a permission id`));
    out['permission'] = m['permission'];
  }
  if (m['domain'] !== undefined) {
    if (typeof m['domain'] !== 'string' || !(PERMISSION_DOMAINS as readonly string[]).includes(m['domain']))
      return err(bad(`${where}.match.domain is unknown`));
    out['domain'] = m['domain'];
  }
  if (m['principalId'] !== undefined) {
    if (typeof m['principalId'] !== 'string' || !PRINCIPAL_ID.test(m['principalId']))
      return err(bad(`${where}.match.principalId is invalid`));
    out['principalId'] = m['principalId'];
  }
  if (m['principalKind'] !== undefined) {
    if (typeof m['principalKind'] !== 'string' || !(PRINCIPAL_KINDS as readonly string[]).includes(m['principalKind']))
      return err(bad(`${where}.match.principalKind is invalid`));
    out['principalKind'] = m['principalKind'];
  }
  if (m['role'] !== undefined) {
    if (typeof m['role'] !== 'string' || !ROLE.test(m['role'])) return err(bad(`${where}.match.role is invalid`));
    out['role'] = m['role'];
  }
  if (m['capabilityId'] !== undefined) {
    if (typeof m['capabilityId'] !== 'string' || !CAPABILITY_ID.test(m['capabilityId']))
      return err(bad(`${where}.match.capabilityId is invalid`));
    out['capabilityId'] = m['capabilityId'];
  }
  if (out['permission'] === undefined && out['domain'] === undefined && out['principalId'] === undefined) {
    return err(bad(`${where}.match must name a permission, a domain or a principal (an unscoped rule is too broad)`));
  }
  return ok(out as PolicyRuleMatch);
}

function touchesWorkspace(match: PolicyRuleMatch): boolean {
  if (match.domain === 'workspace') return true;
  if (match.permission !== undefined) return String(match.permission).startsWith('workspace.');
  return match.domain === undefined; // a principal-only rule applies to every domain, workspace included
}

/** Parse and validate a policy document. Any problem rejects the whole document. */
export function parseInstancePolicy(raw: unknown): Result<InstancePolicyDocument, XoError> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err(bad('document must be an object'));
  const doc = raw as Record<string, unknown>;
  for (const key of Object.keys(doc)) if (!['format', 'revision', 'rules'].includes(key)) return err(bad(`unknown field "${key}"`));
  if (doc['format'] !== INSTANCE_POLICY_FORMAT) return err(bad(`format must be ${INSTANCE_POLICY_FORMAT}`));
  if (!Number.isInteger(doc['revision']) || (doc['revision'] as number) < 0) return err(bad('revision must be a non-negative integer'));
  if (!Array.isArray(doc['rules']) || doc['rules'].length > MAX_RULES) return err(bad(`rules must be an array of at most ${MAX_RULES}`));
  const rules: PolicyRule[] = [];
  const ids = new Set<string>();
  for (const [i, r] of (doc['rules'] as unknown[]).entries()) {
    const where = `rules[${i}]`;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return err(bad(`${where} must be an object`));
    const rule = r as Record<string, unknown>;
    for (const key of Object.keys(rule))
      if (!['id', 'effect', 'match'].includes(key)) return err(bad(`${where} has unknown field "${key}"`));
    if (typeof rule['id'] !== 'string' || !RULE_ID.test(rule['id'])) return err(bad(`${where}.id is invalid`));
    if (ids.has(rule['id'])) return err(bad(`duplicate rule id "${rule['id']}"`));
    ids.add(rule['id']);
    if (rule['effect'] !== 'ALLOW' && rule['effect'] !== 'DENY') return err(bad(`${where}.effect must be ALLOW or DENY`));
    const match = parseMatch(rule['match'], where);
    if (!match.ok) return match;
    if (rule['effect'] === 'ALLOW' && touchesWorkspace(match.value)) {
      return err(
        bad(`${where} would ALLOW workspace operations; workspace access comes from roles (ADR 0010). Only DENY may target them.`),
      );
    }
    rules.push({ id: rule['id'], effect: rule['effect'], match: match.value });
  }
  return ok({ format: INSTANCE_POLICY_FORMAT, revision: doc['revision'] as number, rules });
}

export const EMPTY_INSTANCE_POLICY: InstancePolicyDocument = { format: INSTANCE_POLICY_FORMAT, revision: 0, rules: [] };

function decode(text: string): Result<InstancePolicyDocument, XoError> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err(bad('not valid JSON'));
  }
  return parseInstancePolicy(raw);
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT';
}

/** Read the policy file. Missing => the empty policy. Unreadable or invalid => an error (callers fail closed). */
export async function readInstancePolicy(path: string): Promise<Result<InstancePolicyDocument, XoError>> {
  try {
    return decode(await readFile(path, 'utf8'));
  } catch (cause) {
    if (isMissing(cause)) return ok(EMPTY_INSTANCE_POLICY);
    return err(bad(`cannot read ${path}`));
  }
}

/**
 * Atomically replace the policy file. Refuses (and changes nothing) if the file's current revision is not `expectedRevision`, so two
 * operators editing at once cannot silently lose a change. The written document has revision `expectedRevision + 1`.
 */
export async function writeInstancePolicy(
  path: string,
  rules: readonly PolicyRule[],
  expectedRevision: number,
): Promise<Result<InstancePolicyDocument, XoError>> {
  const current = await readInstancePolicy(path);
  if (!current.ok) return current;
  if (current.value.revision !== expectedRevision) {
    return err(
      new XoError(
        ErrorCode.PRECONDITION_FAILED,
        `instance policy changed (revision ${current.value.revision}, expected ${expectedRevision}); re-read and retry`,
      ),
    );
  }
  const next = parseInstancePolicy({ format: INSTANCE_POLICY_FORMAT, revision: expectedRevision + 1, rules });
  if (!next.ok) return next;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(next.value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  return next;
}

/**
 * The live policy object the server's `PermissionManager` consults. `evaluate` is synchronous (the `PermissionPolicy` contract), so the
 * current rules are held in memory: loaded synchronously at construction, refreshed by {@link reload} (the server calls it on a timer).
 */
export class InstancePolicy implements PermissionPolicy {
  private current: RuleBasedPolicy = new RuleBasedPolicy([]);
  private revision = -1;
  /** Why the operator rules are currently suspended (fail closed), or `undefined` when the file loaded cleanly. */
  lastError: string | undefined;

  constructor(readonly path: string) {
    let text: string | undefined;
    try {
      text = readFileSync(path, 'utf8');
    } catch (cause) {
      if (!isMissing(cause)) this.lastError = `cannot read ${path}`;
    }
    this.apply(text === undefined ? (this.lastError === undefined ? ok(EMPTY_INSTANCE_POLICY) : err(bad(this.lastError))) : decode(text));
  }

  private apply(result: Result<InstancePolicyDocument, XoError>): void {
    if (!result.ok) {
      // Fail closed: no operator ALLOW stays in force while the file cannot be trusted.
      this.current = new RuleBasedPolicy([]);
      this.revision = -1;
      this.lastError = result.error.message;
      return;
    }
    this.current = new RuleBasedPolicy(result.value.rules);
    this.revision = result.value.revision;
    this.lastError = undefined;
  }

  /** Re-read the file. Returns the revision now in force (-1 when suspended). */
  async reload(): Promise<number> {
    this.apply(await readInstancePolicy(this.path));
    return this.revision;
  }

  get activeRevision(): number {
    return this.revision;
  }

  evaluate(request: PermissionRequest): ReturnType<PermissionPolicy['evaluate']> {
    return this.current.evaluate(request);
  }

  getDefaultEffect(): 'ALLOW' | 'DENY' | 'PROMPT' {
    return 'DENY';
  }
}
