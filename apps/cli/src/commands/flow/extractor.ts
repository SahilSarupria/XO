import { DETERMINISTIC_HOST, negotiateWorkflows, type WorkflowComponent } from '@xo/workflow-ir';
import { ModelExtractor, UsageCaps, type Extractor } from '@xo/workflow-runtime';
import { err, ok, type Result } from '@xo/types';
import { resolveOperatorProvider } from '../layer/operator-provider.js';

/**
 * The model an operator lets workflows read free text with. ONE operator-config model for the whole CLI: the same environment contract the TUI and
 * `xo run` use (`XO_PROVIDER`, `XO_MODEL`, the vendor key variable, `XO_PROVIDER_BASE_URL` on the endpoint allowlist), with optional
 * `XO_EXTRACTOR_PROVIDER` / `XO_EXTRACTOR_MODEL` / `XO_EXTRACTOR_BASE_URL` overrides so extraction can use a different (say, local) model than chat.
 * Credentials and endpoints never come from flags, workflow files or packages.
 */
export function resolveExtractor(env: Readonly<Record<string, string | undefined>> = process.env): Result<Extractor, string> {
  const overlay: Record<string, string | undefined> = {
    ...env,
    XO_PROVIDER: env['XO_EXTRACTOR_PROVIDER'] ?? env['XO_PROVIDER'],
    XO_MODEL: env['XO_EXTRACTOR_MODEL'] ?? env['XO_MODEL'],
    XO_PROVIDER_BASE_URL: env['XO_EXTRACTOR_BASE_URL'] ?? env['XO_PROVIDER_BASE_URL'],
  };
  const op = resolveOperatorProvider(overlay);
  if (!op.ok) return err(op.error);
  return ok(new ModelExtractor({ provider: op.value.provider, model: op.value.model }));
}

/**
 * The extractor a workflow needs, or none. A workflow that negotiates as model-free on the reference host gets NO extractor and the environment is
 * never read, so an all-deterministic or structured-input deployment cannot fail on, pay for, or reach a model by accident.
 */
export function extractorFor(
  component: WorkflowComponent,
  workflowId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<Extractor | undefined, string> {
  const n = negotiateWorkflows(component, DETERMINISTIC_HOST);
  if (n.modelFree.includes(workflowId) || n.runnable.includes(workflowId)) return ok(undefined);
  const refusal = n.refused.find((r) => r.workflow === workflowId);
  // only a missing model justifies resolving one; any other reason to refuse is not ours to paper over
  if (refusal !== undefined && !refusal.reasons.some((r) => /model|extract|structured_output/i.test(r)))
    return err(`workflow ${workflowId} cannot run: ${refusal.reasons.join('; ')}`);
  const r = resolveExtractor(env);
  return r.ok ? ok(r.value) : err(`workflow ${workflowId} reads free text with a model, but none is configured: ${r.error}`);
}

/** `--daily-model-calls` / `--daily-effects`: strict positive integers, persisted per UTC day under `<runs>/usage` so a restart cannot reset them. */
export function capsFromFlags(
  flags: Readonly<Record<string, string | boolean | undefined>>,
  runsDir: string,
): Result<UsageCaps | undefined, string> {
  const num = (name: string): Result<number | undefined, string> => {
    const v = flags[name];
    if (v === undefined) return ok(undefined);
    if (typeof v !== 'string' || !/^[1-9][0-9]{0,8}$/.test(v)) return err(`--${name} must be a positive integer`);
    return ok(Number(v));
  };
  const m = num('daily-model-calls');
  if (!m.ok) return m;
  const e = num('daily-effects');
  if (!e.ok) return e;
  if (m.value === undefined && e.value === undefined) return ok(undefined);
  return ok(
    new UsageCaps(`${runsDir}/usage`, {
      ...(m.value !== undefined ? { modelCallsPerDay: m.value } : {}),
      ...(e.value !== undefined ? { effectsPerDay: e.value } : {}),
    }),
  );
}
