import type { Determinism, Step, WorkflowDef } from './types.js';

export interface StepDeterminism {
  readonly step: string;
  readonly type: Step['type'];
  readonly class: Determinism;
  /** Why a non-deterministic step is not deterministic (free text input, human judgement ...). */
  readonly reason?: string;
  /** For `structuredFirst` extracts: the model is bypassed when structured input is supplied. */
  readonly bypassable?: boolean;
  readonly provenance?: readonly string[];
}

export interface DeterminismReport {
  readonly workflow: string;
  readonly steps: readonly StepDeterminism[];
  /** deterministic steps / all steps. A count of declared classes, not a measure of accuracy. */
  readonly ratio: number;
  readonly counts: Readonly<Record<Determinism, number>>;
}

const REASON: Readonly<Record<Step['type'], string | undefined>> = {
  extract: 'reads free text into structured facts with a model',
  approve: 'requires a human decision',
  escalate: 'hands the case to a human',
  decide: undefined,
  act: undefined,
  branch: undefined,
  wait: undefined,
  compensate: undefined,
};

/** Static, declaration-based report. It states what the document says; it measures nothing about real traffic. */
export function determinismReport(wf: WorkflowDef): DeterminismReport {
  const counts: Record<Determinism, number> = { deterministic: 0, model_assisted: 0, human: 0 };
  const steps = wf.steps.map((s): StepDeterminism => {
    counts[s.determinism]++;
    const reason = REASON[s.type];
    return {
      step: s.id,
      type: s.type,
      class: s.determinism,
      ...(reason !== undefined ? { reason } : {}),
      ...(s.type === 'extract' && s.structuredFirst === true ? { bypassable: true } : {}),
      ...(s.provenance !== undefined ? { provenance: s.provenance } : {}),
    };
  });
  return { workflow: wf.id, steps, ratio: wf.steps.length === 0 ? 0 : counts.deterministic / wf.steps.length, counts };
}
