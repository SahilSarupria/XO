import { ErrorCode, XoError } from '@xo/errors';
import { actorFromPrincipal } from '@xo/audit';
import { resolutionChangeOperations, resolveEntities, type Cardinality, type EvidenceRef, type ResolutionItem, type ResolutionSchema } from '@xo/knowledge-base';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId } from '../audit/audit-service.js';
import { workspaceKnowledgeBase } from './knowledge-routes.js';
import { createHash } from 'node:crypto';
import { parseJsonBody } from '../http/body.js';

/**
 * UW-5 (ADR 0040) — entity resolution over HTTP. Deterministic, no model. The caller supplies the two item sets (refs, names,
 * identifiers); XO returns resolved / ambiguous / unmatched per subject with the evidence, plus unmatched sets and cardinality
 * violations. `propose` turns RESOLVED results into `proposed` claims in an ordinary knowledge change set: a person with the review
 * role and a recent sign-in approves it through the existing change-set routes. Audit holds counts and hashes, never names or values.
 */
const CARDINALITIES: readonly Cardinality[] = ['one_to_one', 'one_to_many', 'many_to_one'];
const RULES = ['email', 'alnum', 'exact'] as const;
const MAX_ITEMS = 5000;
const bad = (m: string): never => {
  throw new XoError(ErrorCode.INVALID_ARGUMENT, m);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) bad(`${where}: unknown field(s) ${extra.join(', ')}`);
}

function parseItems(v: unknown, where: string): readonly ResolutionItem[] {
  if (!Array.isArray(v) || v.length > MAX_ITEMS) bad(`${where} must be an array of at most ${MAX_ITEMS} items`);
  const seen = new Set<string>();
  return (v as unknown[]).map((raw, i) => {
    if (!isObj(raw)) return bad(`${where}[${i}] must be an object`);
    onlyKeys(raw, ['ref', 'name', 'identifiers'], `${where}[${i}]`);
    if (typeof raw['ref'] !== 'string' || raw['ref'] === '' || raw['ref'].length > 200) bad(`${where}[${i}].ref must be a non-empty string`);
    const ref = raw['ref'] as string;
    if (seen.has(ref)) bad(`${where}: duplicate ref ${ref.slice(0, 40)}`);
    seen.add(ref);
    if (raw['name'] !== undefined && typeof raw['name'] !== 'string') bad(`${where}[${i}].name must be a string`);
    const ids = raw['identifiers'];
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every((x) => isObj(x) && typeof x['scheme'] === 'string' && typeof x['value'] === 'string')))
      bad(`${where}[${i}].identifiers must be [{ scheme, value }]`);
    return {
      ref,
      ...(raw['name'] === undefined ? {} : { name: raw['name'] as string }),
      ...(ids === undefined ? {} : { identifiers: (ids as { scheme: string; value: string }[]).map((x) => ({ scheme: x.scheme, value: x.value })) }),
    };
  });
}

function parseSchema(v: unknown): ResolutionSchema {
  if (!isObj(v)) return bad('schema must be an object');
  onlyKeys(v, ['relationship', 'cardinality', 'strongSchemes', 'minNameWords'], 'schema');
  if (typeof v['relationship'] !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(v['relationship'])) bad('schema.relationship must be a short identifier');
  if (!CARDINALITIES.includes(v['cardinality'] as Cardinality)) bad(`schema.cardinality must be one of ${CARDINALITIES.join(', ')}`);
  const ss = v['strongSchemes'];
  if (!isObj(ss) || !Object.values(ss).every((r) => (RULES as readonly unknown[]).includes(r))) bad(`schema.strongSchemes must map scheme to one of ${RULES.join(', ')}`);
  const mw = v['minNameWords'];
  if (mw !== undefined && (!Number.isInteger(mw) || (mw as number) < 1 || (mw as number) > 5)) bad('schema.minNameWords must be an integer 1 to 5');
  return {
    relationship: v['relationship'] as string,
    cardinality: v['cardinality'] as Cardinality,
    strongSchemes: ss as ResolutionSchema['strongSchemes'],
    ...(mw === undefined ? {} : { minNameWords: mw as number }),
  };
}

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);

export function registerResolutionRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig, audit: AuditService): void {
  const auditCtx = { audit, workspaceStore };

  async function run(req: ApiRequest, propose: boolean): Promise<ApiResponse> {
    try {
      const correlationId = newCorrelationId();
      const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: propose ? 'resolution.propose' : 'resolution.compute', correlationId });
      await requirePermission(req, workspace, 'author', dataConfig, { action: propose ? 'propose entity resolution' : 'compute entity resolution' });
      const parsed = parseJsonBody(await req.rawBody());
      if (!parsed.ok) throw parsed.error;
      const b = parsed.value;
      if (!isObj(b)) return bad('body must be a JSON object');
      onlyKeys(b, propose ? ['schema', 'subjects', 'candidates', 'evidence'] : ['schema', 'subjects', 'candidates'], 'body');
      const schema = parseSchema(b['schema']);
      const subjects = parseItems(b['subjects'], 'subjects');
      const candidates = parseItems(b['candidates'], 'candidates');
      const report = resolveEntities(schema, subjects, candidates);
      const actor = requirePrincipal(req);
      const count = (o: string) => report.results.filter((r) => r.outcome === o).length;
      const metadata = {
        relationshipHash: hash(schema.relationship),
        subjects: subjects.length,
        candidates: candidates.length,
        resolved: count('resolved'),
        ambiguous: count('ambiguous'),
        unmatched: count('unmatched'),
        violations: report.violations.length,
        itemsHash: hash({ subjects, candidates }),
      };
      if (!propose) {
        await audit.tryRecord({
          action: 'resolution.compute',
          actor: actorFromPrincipal(actor),
          correlationId,
          target: { kind: 'knowledge-change-set', id: metadata.itemsHash, workspaceId: workspace.workspaceId },
          type: 'resolution.computed',
          outcome: 'completed',
          metadata,
        });
        return json(200, { report });
      }
      const evRaw = b['evidence'];
      if (!isObj(evRaw)) return bad('evidence must map each item ref to its source evidence');
      const refs = new Set([...subjects, ...candidates].map((i) => i.ref));
      const evidenceByRef: Record<string, EvidenceRef> = {};
      for (const [ref, e] of Object.entries(evRaw)) {
        if (!refs.has(ref)) bad('evidence names a ref that is not an item');
        if (!isObj(e) || typeof e['sourceDigestSha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(e['sourceDigestSha256']) || typeof e['sourceName'] !== 'string' || !isObj(e['locator']))
          return bad('each evidence entry needs sourceDigestSha256 (hex), sourceName and locator');
        evidenceByRef[ref] = {
          sourceDigestSha256: e['sourceDigestSha256'],
          sourceName: e['sourceName'],
          locator: e['locator'] as EvidenceRef['locator'],
          method: { kind: 'system', name: 'xo-entity-resolver', version: '1' },
        };
      }
      const operations = resolutionChangeOperations(report, { tenantId: workspace.workspaceId, relationship: schema.relationship, recordedAt: new Date().toISOString(), evidenceByRef });
      const kb = await workspaceKnowledgeBase(workspace, dataConfig);
      const changeSet = await kb.propose({ operations, origin: { kind: 'import', ref: `resolution:${metadata.itemsHash}` }, proposedBy: { id: actor.id, kind: actor.kind } });
      if (changeSet !== undefined)
        await audit.tryRecord({
          action: 'resolution.propose',
          actor: actorFromPrincipal(actor),
          correlationId,
          target: { kind: 'knowledge-change-set', id: changeSet.changeSetId, workspaceId: workspace.workspaceId },
          type: 'knowledge.change-set.proposed',
          outcome: 'completed',
          metadata: { ...metadata, operations: operations.length },
        });
      return json(changeSet === undefined ? 200 : 201, { changeSet: changeSet ?? null, report, proposed: operations.length });
    } catch (cause) {
      return errorToResponse(cause);
    }
  }

  router.post('/workspaces/:workspaceId/entity-resolutions', (req) => run(req, false));
  router.post('/workspaces/:workspaceId/entity-resolutions/proposals', (req) => run(req, true));
}
