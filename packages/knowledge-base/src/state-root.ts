/**
 * UW-4b (ADR 0017, ADR 0034) — the content root of a knowledge state, and the head pointer.
 *
 * A state's `stateId` names a point in HISTORY: it hashes the parent state and the change set that made it, so two states
 * reached by different approvals have different ids even when they hold the same knowledge. The CONTENT ROOT names what the
 * state holds: a Merkle root over its approved content (each entry's record digest and lifecycle, every conflict and its
 * ruling, the pack bindings and precedence policy). Two states with the same content have the same root, whatever path led
 * there; a rebuilt store reproduces both the ids and the roots. Retrieval indexes are keyed by state id and checked against
 * the root.
 *
 * The head pointer is the one mutable value of the knowledge base: which state is active. Stores that keep one move it only by
 * compare-and-swap from the state the approval was based on, inside the same transaction that writes the state, its decision
 * and its events — so an approval is all-or-nothing and two approvals against one head cannot both win, even if a caller's
 * lock were wrong.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import type { KnowledgeState } from './types.js';

export interface HeadPointer {
  readonly stateId: string;
  readonly contentRoot: string;
  /** Sequence number of the `state.created` event that made this state the head. */
  readonly eventSeq: number;
}

/** The head moved between reading it and swapping it: another approval won. */
export class StaleHeadError extends Error {
  constructor(
    readonly expected: string | null,
    readonly actual: string | null,
  ) {
    super(`the knowledge head is ${actual ?? 'the empty root'}, not ${expected ?? 'the empty root'}`);
  }
}

const h = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Leaves, sorted by their own bytes: content only, never order of approval. */
export function stateLeaves(state: Pick<KnowledgeState, 'entries' | 'conflicts' | 'packBindings' | 'precedencePolicy'>): string[] {
  const leaves: string[] = [];
  for (const e of state.entries)
    leaves.push(
      canonicalJson({
        t: 'entry',
        id: e.id,
        kind: e.kind,
        digest: e.recordDigest,
        lifecycle: e.lifecycle,
        mergedInto: e.mergedInto,
        interpretation: e.interpretation,
      }),
    );
  for (const c of state.conflicts)
    leaves.push(
      canonicalJson({
        t: 'conflict',
        id: c.id,
        claims: [...c.claims].sort(),
        status: c.status,
        prevailing: c.prevailing,
        ruledBy: c.resolution?.by,
        rationale: c.resolution?.rationale,
      }),
    );
  for (const p of state.packBindings) leaves.push(canonicalJson({ t: 'pack', ...p }));
  leaves.push(canonicalJson({ t: 'precedence', ...state.precedencePolicy }));
  return leaves.sort();
}

/** `sha256:` Merkle root (RFC 6962 style: 0x00 leaf prefix, 0x01 node prefix, an odd node is promoted). */
export function stateContentRoot(state: Pick<KnowledgeState, 'entries' | 'conflicts' | 'packBindings' | 'precedencePolicy'>): string {
  let level: Buffer[] = stateLeaves(state).map((l) =>
    createHash('sha256')
      .update(Buffer.concat([Buffer.from([0]), Buffer.from(l)]))
      .digest(),
  );
  if (level.length === 0) level = [h('')];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1];
      next.push(
        right === undefined
          ? level[i]!
          : createHash('sha256')
              .update(Buffer.concat([Buffer.from([1]), level[i]!, right]))
              .digest(),
      );
    }
    level = next;
  }
  return `sha256:${level[0]!.toString('hex')}`;
}
