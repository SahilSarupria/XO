import { createHash } from 'node:crypto';
import type { Question } from './clarify.js';
import type { PolicyProgram, Step } from './program.js';
import type { ReviewLedger } from './review.js';

/**
 * When the manual changes, say exactly what changed in the compiled policy and which earlier human rulings no longer
 * apply — instead of recompiling silently. Steps are matched by the sentence they were read from (exact, then closest
 * rewording), so a changed number ("30 days" → "45 days") shows up as a changed number, not as one rule vanishing and
 * another appearing.
 */
export const manualRevision = (text: string): string =>
  createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

const normSentence = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9$%.]+/g, ' ')
    .trim();
const words = (s: string): Set<string> =>
  new Set(
    normSentence(s)
      .split(' ')
      .filter((w) => w.length > 2),
  );
const numbersOf = (s: string): string[] => [...s.matchAll(/\$?\d[\d,]*(?:\.\d+)?%?/g)].map((m) => m[0]);

export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

const signature = (s: Step): string =>
  JSON.stringify(s.kind === 'gate' ? [s.when, s.outcome] : s.kind === 'assign' ? [s.set] : [s.when, s.outcome, s.amount]);

export interface StepChange {
  readonly kind: 'added' | 'removed' | 'reworded' | 'rule_changed';
  readonly before?: string;
  readonly after?: string;
  /** numbers that differ between the old and new sentence, e.g. "30 → 45" */
  readonly numbers?: readonly string[];
  /** true when the compiled rule itself (condition/outcome/amount) differs, not only the wording */
  readonly behaviourChanged: boolean;
}
export interface ProgramDiff {
  readonly changes: readonly StepChange[];
  readonly factsAdded: readonly string[];
  readonly factsRemoved: readonly string[];
  readonly unchanged: number;
  readonly behaviourChanged: boolean;
}

export function diffPrograms(before: PolicyProgram, after: PolicyProgram): ProgramDiff {
  const changes: StepChange[] = [];
  const oldLeft = [...before.steps];
  const newLeft = [...after.steps];
  let unchanged = 0;
  for (const n of [...newLeft]) {
    const i = oldLeft.findIndex((o) => normSentence(o.source.sentence) === normSentence(n.source.sentence));
    if (i === -1) continue;
    const o = oldLeft[i]!;
    oldLeft.splice(i, 1);
    newLeft.splice(newLeft.indexOf(n), 1);
    if (signature(o) === signature(n)) unchanged++;
    else changes.push({ kind: 'rule_changed', before: o.source.sentence, after: n.source.sentence, behaviourChanged: true });
  }
  for (const n of [...newLeft]) {
    let best = -1;
    let score = 0;
    oldLeft.forEach((o, i) => {
      const s = similarity(o.source.sentence, n.source.sentence);
      if (s > score) {
        score = s;
        best = i;
      }
    });
    if (best !== -1 && score >= 0.6) {
      const o = oldLeft.splice(best, 1)[0]!;
      newLeft.splice(newLeft.indexOf(n), 1);
      const a = numbersOf(o.source.sentence);
      const b = numbersOf(n.source.sentence);
      const diff = a.flatMap((x, k) => (b[k] !== undefined && b[k] !== x ? [`${x} → ${b[k]}`] : []));
      changes.push({
        kind: 'reworded',
        before: o.source.sentence,
        after: n.source.sentence,
        ...(diff.length > 0 ? { numbers: diff } : {}),
        behaviourChanged: signature(o) !== signature(n) || diff.length > 0,
      });
    }
  }
  for (const o of oldLeft) changes.push({ kind: 'removed', before: o.source.sentence, behaviourChanged: true });
  for (const n of newLeft) changes.push({ kind: 'added', after: n.source.sentence, behaviourChanged: true });
  const oldF = new Set(before.facts.map((f) => f.name));
  const newF = new Set(after.facts.map((f) => f.name));
  return {
    changes,
    factsAdded: [...newF].filter((f) => !oldF.has(f)),
    factsRemoved: [...oldF].filter((f) => !newF.has(f)),
    unchanged,
    behaviourChanged: changes.some((c) => c.behaviourChanged),
  };
}

export interface LedgerStatus {
  readonly current: ReviewLedger;
  /** rulings whose sentence is gone or reworded: they are NOT applied until a person re-confirms them */
  readonly stale: readonly { readonly sentence: string; readonly nearest?: string; readonly similarity: number }[];
}

/** Which of a person's earlier rulings still match the new manual text. */
export function ledgerStatus(ledger: ReviewLedger, currentSentences: readonly string[]): LedgerStatus {
  const have = new Set(currentSentences.map(normSentence));
  const keepA = ledger.accepted.filter((a) => have.has(normSentence(a.sentence)));
  const keepR = ledger.rejected.filter((r) => have.has(normSentence(r.sentence)));
  const stale = [
    ...ledger.accepted.filter((a) => !have.has(normSentence(a.sentence))).map((a) => a.sentence),
    ...ledger.rejected.filter((r) => !have.has(normSentence(r.sentence))).map((r) => r.sentence),
  ].map((sentence) => {
    let nearest: string | undefined;
    let best = 0;
    for (const c of currentSentences) {
      const s = similarity(sentence, c);
      if (s > best) {
        best = s;
        nearest = c;
      }
    }
    return { sentence, ...(nearest !== undefined && best >= 0.4 ? { nearest } : {}), similarity: Math.round(best * 100) / 100 };
  });
  return { current: { accepted: keepA, rejected: keepR }, stale };
}

/** A stale ruling becomes a question: the old answer is shown next to the new wording and a person re-confirms. */
export function staleRulingQuestions(status: LedgerStatus): Question[] {
  return status.stale.map((s, i) => ({
    id: `reconfirm-${i + 1}`,
    kind: 'reconfirm_ruling' as const,
    prompt:
      s.nearest !== undefined
        ? `You previously ruled on: “${s.sentence}” The manual now says: “${s.nearest}” Does your earlier ruling still apply?`
        : `You previously ruled on: “${s.sentence}” That sentence is no longer in the manual. Should the ruling be dropped?`,
    evidence: s.nearest !== undefined ? [s.sentence, s.nearest] : [s.sentence],
    options: ['still applies', 'drop it', 'rewrite'],
    blocking: true,
    subject: s.sentence,
  }));
}
