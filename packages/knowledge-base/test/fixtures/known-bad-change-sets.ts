/**
 * UAC-21: change sets that must never reach the active state. Each case names the finding code that blocks it. Cases that
 * need a base build against `base` (an active entity and a claim about it).
 */
import type { ChangeOperation, ChangeSet, ClaimRecord, EntityRecord, EvidenceRef, RelationshipRecord } from '../../src/index.js';

export const SRC = 'a'.repeat(64);
export const ev = (digest = SRC): EvidenceRef[] => [
  {
    sourceDigestSha256: digest,
    sourceName: 'policy.md',
    locator: { section: ['Refunds'] },
    method: { kind: 'source', name: 'test', version: '1' },
  },
];

export function entityRec(tenant: string, name: string, digest = SRC, extra: Partial<EntityRecord> = {}): EntityRecord {
  return {
    kind: 'entity',
    id: `ent_${Buffer.from(tenant + name)
      .toString('hex')
      .padEnd(24, '0')
      .slice(0, 24)}`,
    tenantId: tenant,
    type: 'xo:concept.organization',
    canonicalName: name,
    aliases: [],
    identifiers: [],
    attributes: {},
    evidence: ev(digest),
    derivation: 'source',
    confidence: 0.9,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

export function claimRec(
  tenant: string,
  id: string,
  subjectEntityId: string,
  value: string,
  digest = SRC,
  extra: Partial<ClaimRecord> = {},
): ClaimRecord {
  return {
    kind: 'claim',
    id,
    tenantId: tenant,
    type: 'xo:heuristic',
    subject: { entityId: subjectEntityId },
    predicate: 'xo:heuristic',
    object: { value },
    polarity: 'positive',
    authority: { level: 'source', basis: 'stated in policy.md' },
    text: `${subjectEntityId}: ${value}`,
    evidence: ev(digest),
    derivation: 'source',
    confidence: 0.9,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

export interface BadCase {
  readonly name: string;
  readonly code: string;
  readonly origin: ChangeSet['origin']['kind'];
  readonly build: (base: { tenant: string; entityId: string; claimId: string }) => readonly ChangeOperation[];
}

export const KNOWN_BAD: readonly BadCase[] = [
  {
    name: 'a record naming another tenant',
    code: 'cross-tenant',
    origin: 'manual',
    build: () => [{ op: 'add', record: entityRec('other-tenant', 'Elsewhere') }],
  },
  {
    name: 'a relationship pointing at nothing',
    code: 'dangling-relationship',
    origin: 'manual',
    build: ({ tenant }) => [
      {
        op: 'add',
        record: {
          kind: 'relationship',
          id: 'rel_000000000000000000000101',
          tenantId: tenant,
          type: 'xo:relates',
          from: 'ent_000000000000000000000102',
          to: 'ent_000000000000000000000103',
          directed: true,
          evidence: ev(),
          derivation: 'source',
          confidence: 0.9,
          recordedAt: '2026-01-01T00:00:00.000Z',
        } satisfies RelationshipRecord,
      },
    ],
  },
  {
    name: 'a claim with no evidence',
    code: 'no-evidence',
    origin: 'manual',
    build: ({ tenant, entityId }) => [
      { op: 'add', record: claimRec(tenant, 'clm_000000000000000000000104', entityId, 'x', SRC, { evidence: [] }) },
    ],
  },
  {
    name: 'a model-derived authoritative claim',
    code: 'authority-escalation',
    origin: 'manual',
    build: ({ tenant, entityId }) => [
      {
        op: 'add',
        record: claimRec(tenant, 'clm_000000000000000000000105', entityId, 'm', SRC, {
          derivation: 'model',
          authority: { level: 'authoritative', basis: 'model said so' },
        }),
      },
    ],
  },
  {
    name: 'a run-outcome record above source authority',
    code: 'authority-escalation',
    origin: 'run-outcome',
    build: ({ tenant, entityId }) => [
      {
        op: 'add',
        record: claimRec(tenant, 'clm_000000000000000000000106', entityId, 'r', SRC, {
          derivation: 'human',
          authority: { level: 'reviewed', basis: 'a run' },
        }),
      },
    ],
  },
  {
    name: 'an authoritative claim from a reconciliation',
    code: 'authority-escalation',
    origin: 'xoir-reconciliation',
    build: ({ tenant, entityId }) => [
      {
        op: 'add',
        record: claimRec(tenant, 'clm_000000000000000000000107', entityId, 'a', SRC, {
          authority: { level: 'authoritative', basis: 'compiled' },
        }),
      },
    ],
  },
  {
    name: 'retiring an entity an active claim still points at',
    code: 'dependency',
    origin: 'manual',
    build: ({ entityId }) => [{ op: 'retire', recordId: entityId, lifecycle: 'expired', reason: 'gone' }],
  },
  {
    name: 'merging into an unknown entity',
    code: 'unknown-record',
    origin: 'manual',
    build: ({ entityId }) => [{ op: 'merge-entities', from: [entityId], into: 'ent_000000000000000000000108', reason: 'dup' }],
  },
  {
    name: 'a type that is not namespaced',
    code: 'bad-type',
    origin: 'manual',
    build: ({ tenant }) => [{ op: 'add', record: entityRec(tenant, 'Odd', SRC, { type: 'not namespaced' }) }],
  },
  {
    name: 'resolving a conflict that does not exist',
    code: 'unknown-conflict',
    origin: 'manual',
    build: ({ claimId }) => [
      { op: 'resolve-conflict', conflictId: 'cfl_000000000000000000000109', prevailing: claimId, rationale: 'because' },
    ],
  },
  {
    name: 'a restore outside a rollback',
    code: 'restore-outside-rollback',
    origin: 'manual',
    build: ({ claimId }) => [{ op: 'restore', recordId: claimId, lifecycle: 'active', reason: 'back' }],
  },
  {
    name: 'retiring a record that is not in the state',
    code: 'unknown-record',
    origin: 'manual',
    build: () => [{ op: 'retire', recordId: 'clm_00000000000000000000010a', lifecycle: 'expired', reason: 'x' }],
  },
];
