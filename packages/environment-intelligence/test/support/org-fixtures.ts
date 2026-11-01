import type { JsonValue } from '../../src/index.js';
import type { OrgProvider } from './knowledge-env.js';
import { type KnowledgeEnv } from './knowledge-env.js';
import { deriveKnowledge } from '../../src/index.js';
import assert from 'node:assert/strict';

export const HR = '/org/hr-directory';
export const MAIL = '/org/mail';
export const PM = '/org/project-tool';
export const POLICY = '/org/policy-docs';
export const PATHS = [HR, MAIL, PM, POLICY] as const;

export const person = (ids: Record<string, string>): JsonValue => ({ kind: 'person', ids });
export const team = (key: string): JsonValue => ({ kind: 'team', ids: { team_key: key } });
export const project = (key: string): JsonValue => ({ kind: 'project', ids: { project_key: key } });
export const org = (key: string): JsonValue => ({ kind: 'organization', ids: { org_key: key } });

export const PRIYA = { employee_id: 'E100', email: 'priya@acme.test', name: 'Priya Sharma' };
export const ANITA = { employee_id: 'E001', email: 'anita@acme.test' };
export const RAJ = { employee_id: 'E200', email: 'raj@acme.test' };

/** Seeds the four organizational sources. One page of items, then an empty "caught up" page. */
export function seedOrg(p: OrgProvider): OrgProvider {
  p.set(HR, undefined, {
    items: [
      { key: 'anita', record: { type: 'directory_entry', person: person(ANITA), title: 'CFO' } },
      {
        key: 'priya-2024',
        record: {
          type: 'directory_entry',
          person: person(PRIYA),
          title: 'Finance Manager',
          team: team('FIN'),
          manager: person({ employee_id: 'E001' }),
          valid_from: '2024-01-01',
          valid_to: '2026-06-01',
        },
      },
      {
        key: 'priya-2026',
        record: {
          type: 'directory_entry',
          person: person(PRIYA),
          title: 'Senior Finance Manager',
          team: team('FIN'),
          manager: person({ employee_id: 'E001' }),
          valid_from: '2026-06-01',
        },
      },
      {
        key: 'raj',
        record: {
          type: 'directory_entry',
          person: person(RAJ),
          title: 'Analyst',
          team: team('FIN'),
          manager: person({ employee_id: 'E100' }),
        },
      },
    ],
    next: 'c1',
  });
  p.set(HR, 'c1', { items: [], next: 'c1' });
  p.set(MAIL, undefined, {
    items: [
      {
        key: 'msg-1',
        record: {
          type: 'message',
          from: person({ email: 'priya@acme.test' }),
          to: [person({ email: 'raj@acme.test' })],
          project: project('PRJ-ATLAS'),
          statements: [{ kind: 'policy', subject: org('ACME'), predicate: 'approval_limit', value: 300000 }],
        },
      },
      {
        key: 'msg-2',
        record: {
          type: 'message',
          from: person({ email: 'raj@acme.test' }),
          to: [person({ email: 'anita@acme.test' })],
          project: project('PRJ-CORE'),
        },
      },
    ],
    next: 'c1',
  });
  p.set(MAIL, 'c1', { items: [], next: 'c1' });
  p.set(PM, undefined, {
    items: [
      {
        key: 'atlas',
        record: {
          type: 'work_item',
          project: project('PRJ-ATLAS'),
          owner: person({ email: 'priya@acme.test' }),
          depends_on: [project('PRJ-CORE')],
          status: 'active',
        },
      },
      {
        key: 'thread-9',
        record: {
          type: 'message',
          from: person({ email: 'raj@acme.test' }),
          to: [person({ email: 'priya@acme.test' })],
          project: project('PRJ-ATLAS'),
        },
      },
    ],
    next: 'c1',
  });
  p.set(PM, 'c1', { items: [], next: 'c1' });
  p.set(POLICY, undefined, {
    items: [
      {
        key: 'finance-policy',
        record: { type: 'policy_clause', subject: org('ACME'), attribute: 'approval_limit', value: 500000, governs: team('FIN') },
      },
      {
        key: 'travel-v1',
        record: {
          type: 'policy_clause',
          subject: org('ACME'),
          attribute: 'travel_limit',
          value: 3000,
          effective_from: '2025-01-01',
          effective_to: '2026-01-01',
        },
      },
      {
        key: 'travel-v2',
        record: { type: 'policy_clause', subject: org('ACME'), attribute: 'travel_limit', value: 5000, effective_from: '2026-01-01' },
      },
    ],
    next: 'c1',
  });
  p.set(POLICY, 'c1', { items: [], next: 'c1' });
  return p;
}

/** Ingest ONE batch of a source through the real C4 `ingestSource`, then derive exactly that result. */
export async function load(env: KnowledgeEnv, path: string) {
  const ingestion = await env.ingest(path, { maxBatches: 1 });
  const derived = await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(path), reader: env.staging, ingestion }, env.ctx);
  assert.ok(derived.ok, `derive should succeed: ${derived.ok ? '' : derived.error.code}`);
  return { ingestion, derived: derived.value };
}

export async function loadAll(env: KnowledgeEnv): Promise<void> {
  for (const p of PATHS) await load(env, p);
}
