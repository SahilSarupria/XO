import type { Measure, RegisterItem, Threshold } from './types.js';

/**
 * UW-13 — the two governance inputs of the harness, both owner-controlled data files in `evaluation/`:
 * thresholds (UAC-19) and the commercial readiness register (UAC-20). This module validates them and evaluates measures against them.
 */
export interface ThresholdCheck {
  readonly measure: string;
  readonly status: Threshold['status'];
  readonly bound: string;
  readonly value?: number;
  /** For a ratified threshold: whether the measure meets it. A proposal is never pass or fail. `no-cases`: nothing to measure this run. */
  readonly outcome: 'pass' | 'fail' | 'proposal' | 'not-measured' | 'no-cases';
}

export function validateThresholds(thresholds: readonly Threshold[]): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const t of thresholds) {
    if (seen.has(t.measure)) problems.push(`${t.measure}: defined twice`);
    seen.add(t.measure);
    if (t.min === undefined && t.max === undefined) problems.push(`${t.measure}: needs min or max`);
    if (t.status !== 'proposed' && t.status !== 'ratified') problems.push(`${t.measure}: status must be proposed or ratified`);
    if (t.status === 'ratified' && (t.ratifiedBy === undefined || t.ratifiedAt === undefined))
      problems.push(`${t.measure}: a ratified threshold records who ratified it and when`);
    if (t.rationale.trim() === '') problems.push(`${t.measure}: needs a rationale`);
  }
  return problems;
}

export function checkThresholds(thresholds: readonly Threshold[], measures: readonly Measure[]): readonly ThresholdCheck[] {
  const byId = new Map(measures.map((m) => [m.id, m]));
  return thresholds.map((t) => {
    const m = byId.get(t.measure);
    const bound = [t.min !== undefined ? `≥ ${t.min}` : undefined, t.max !== undefined ? `≤ ${t.max}` : undefined]
      .filter(Boolean)
      .join(' and ');
    if (m === undefined) return { measure: t.measure, status: t.status, bound, outcome: 'not-measured' };
    if (m.value === null) return { measure: t.measure, status: t.status, bound, outcome: 'no-cases' };
    const meets = (t.min === undefined || m.value >= t.min) && (t.max === undefined || m.value <= t.max);
    return {
      measure: t.measure,
      status: t.status,
      bound,
      value: m.value,
      outcome: t.status === 'proposed' ? 'proposal' : meets ? 'pass' : 'fail',
    };
  });
}

export interface RegisterReport {
  readonly problems: readonly string[];
  readonly pilotBlocking: number;
  /** Pilot-blocking items neither closed nor explicitly accepted: the first pilot waits for these (UAC-20). */
  readonly pilotBlockers: readonly string[];
  readonly byStatus: Readonly<Record<RegisterItem['status'], number>>;
}

export function checkRegister(items: readonly RegisterItem[]): RegisterReport {
  const problems: string[] = [];
  const ids = items.map((i) => i.id);
  for (let n = 1; n <= 18; n++) if (!ids.includes(`R${n}`)) problems.push(`R${n} is missing from the register`);
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.id)) problems.push(`${i.id}: listed twice`);
    seen.add(i.id);
    if (i.owner.trim() === '') problems.push(`${i.id}: has no owner`);
    if (!['open', 'in_progress', 'closed', 'accepted'].includes(i.status)) problems.push(`${i.id}: status "${i.status}" is not valid`);
    if (i.status === 'accepted' && (i.acceptedBy === undefined || i.acceptedAt === undefined))
      problems.push(`${i.id}: an accepted item records who accepted the risk and when`);
    if (i.status === 'closed' && i.evidence.length === 0) problems.push(`${i.id}: a closed item cites its evidence`);
  }
  const byStatus = { open: 0, in_progress: 0, closed: 0, accepted: 0 } as Record<RegisterItem['status'], number>;
  for (const i of items) if (i.status in byStatus) byStatus[i.status]++;
  const blocking = items.filter((i) => i.pilotBlocking);
  return {
    problems,
    pilotBlocking: blocking.length,
    pilotBlockers: blocking.filter((i) => i.status !== 'closed' && i.status !== 'accepted').map((i) => i.id),
    byStatus,
  };
}
