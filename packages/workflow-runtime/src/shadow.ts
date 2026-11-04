import type { WorkflowDef } from '@xo/workflow-ir';
import type { RunStore } from './journal.js';
import { replayRun } from './runner.js';

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). Returns objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows;
  if (head === undefined) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

export interface ShadowRow {
  readonly key: string;
  readonly runId: string;
  readonly workflow: string; // what the workflow decided; 'ESCALATED' when it deferred to a person
  readonly human: string | undefined;
  readonly verdict: 'agree' | 'disagree' | 'deferred' | 'no_human_decision';
}

export interface ShadowReport {
  readonly total: number;
  readonly agree: number;
  readonly disagree: number;
  /** The workflow escalated instead of deciding. Safe by design; counted separately from disagreement. */
  readonly deferred: number;
  readonly noHumanDecision: number;
  /** Human rows with no shadow run. */
  readonly unmatchedHuman: readonly string[];
  /** agree / (agree + disagree): agreement among cases the workflow chose to decide. NOT an accuracy claim about production. */
  readonly agreementWhenDeciding: number | undefined;
  readonly rows: readonly ShadowRow[];
}

/**
 * Compares shadow runs with human decisions. `keyInput` names the workflow input that identifies a case (for example
 * claim_id); the CSV must have a column of the same name and a column named `resultField` holding the human decision.
 */
export async function compareShadow(
  store: RunStore,
  wf: WorkflowDef,
  humanCsv: string,
  o: { keyInput: string; resultField: string },
): Promise<ShadowReport> {
  const humans = new Map(parseCsv(humanCsv).map((r) => [r[o.keyInput] ?? '', r[o.resultField] ?? '']));
  const rows: ShadowRow[] = [];
  const seen = new Set<string>();
  for (const id of await store.list()) {
    const rec = replayRun(await store.read(id), wf, id);
    if (rec === undefined || !rec.shadow) continue;
    const key = String(rec.inputs[o.keyInput] ?? '');
    seen.add(key);
    const wfDecision = rec.state === 'completed' && rec.result !== undefined ? String(rec.result[o.resultField] ?? '') : 'ESCALATED';
    const human = humans.get(key);
    const verdict: ShadowRow['verdict'] =
      human === undefined ? 'no_human_decision' : wfDecision === 'ESCALATED' ? 'deferred' : wfDecision === human ? 'agree' : 'disagree';
    rows.push({ key, runId: id, workflow: wfDecision, human, verdict });
  }
  const n = (v: ShadowRow['verdict']): number => rows.filter((r) => r.verdict === v).length;
  const agree = n('agree');
  const disagree = n('disagree');
  return {
    total: rows.length,
    agree,
    disagree,
    deferred: n('deferred'),
    noHumanDecision: n('no_human_decision'),
    unmatchedHuman: [...humans.keys()].filter((k) => !seen.has(k)),
    agreementWhenDeciding: agree + disagree === 0 ? undefined : agree / (agree + disagree),
    rows,
  };
}
