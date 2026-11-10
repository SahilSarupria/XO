import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RunStore,
  StaticReviewerRegistry,
  loadReviewerFile,
  applyPatch,
  casesFromApprovals,
  patchHash,
  proposeRules,
  signPatchAcceptance,
  validatePatch,
  type LoggedCase,
  type PatchAcceptance,
  type RulePatch,
} from '@xo/workflow-runtime';
import type { WorkflowComponent } from '@xo/workflow-ir';

type Flags = Readonly<Record<string, string | boolean>>;
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => (process.stderr.write(`error: ${s}\n`), 1);
const flag = (f: Flags, n: string): string | undefined => (typeof f[n] === 'string' ? (f[n] as string) : undefined);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(resolve(p), 'utf8')) as T;

export const PROMOTE_USAGE =
  'xo flow promote propose <workflows.json> --workflow <id> --runs <dir> --approve-step <id> --step <decide-id> --output-field <name> --out <dir> [--min-support 5]\n' +
  '                                  Cluster repeated human decisions into a reviewable patch + the cases behind it, and shadow-validate it. Changes nothing live.\n' +
  'xo flow promote accept --patch <patch.json> --key <publisher-private.pem> --reviewer <id> --out <acceptance.json>\n' +
  '                                  A publisher signs EXACTLY that patch. Read the patch first: the signature is the only gate.\n' +
  'xo flow promote apply <workflows.json> --patch <patch.json> --cases <cases.json> --acceptance <acceptance.json> --reviewers <reviewers.json> --out <new.json>\n' +
  '                                  Writes the next version ONLY with a verifying signature from a trusted, non-revoked publisher. Package, sign and install it as usual.';

/** `xo flow promote …`. Nothing here edits a live workflow: the only output is a new component file, and only with a signed acceptance. */
export async function runPromote(positionals: readonly string[], flags: Flags): Promise<number> {
  const [, action, file] = positionals;
  try {
    if (action === 'propose') {
      const [runs, wfId, approve, step, field, dir] = ['runs', 'workflow', 'approve-step', 'step', 'output-field', 'out'].map((n) =>
        flag(flags, n),
      );
      if (file === undefined || [runs, wfId, approve, step, field, dir].some((v) => v === undefined)) return fail(PROMOTE_USAGE);
      const min = flag(flags, 'min-support') === undefined ? 5 : Number(flag(flags, 'min-support'));
      if (!Number.isInteger(min) || min < 2) return fail('--min-support must be an integer >= 2 (one case is an anecdote, not a pattern)');
      const comp = readJson<WorkflowComponent>(file);
      const wf = comp.workflows.find((w) => w.id === wfId);
      if (wf === undefined) return fail(`no workflow "${wfId}" in ${file}`);
      const cases = await casesFromApprovals(new RunStore(resolve(runs as string)), wf, approve as string);
      const patch = proposeRules(cases, { workflow: wf, step: step as string, outputField: field as string, minSupport: min });
      const v = validatePatch(patch, cases, min);
      const d = resolve(dir as string);
      writeFileSync(`${d}.patch.json`, JSON.stringify(patch, null, 2));
      writeFileSync(`${d}.cases.json`, JSON.stringify(cases, null, 2));
      out(`${cases.length} logged case(s); ${patch.rules.length} rule(s) proposed; shadow validation: ${v.ok ? 'PASSED' : 'FAILED'}.`);
      for (const r of patch.rules) out(`  ${r.id}: when ${r.when} -> ${r.outcome} (support ${r.support})`);
      for (const why of v.reasons) out(`  refused: ${why}`);
      out(
        `covered ${v.covered}/${v.cases} cases; ${v.disagree.length} contradiction(s). Wrote ${d}.patch.json and ${d}.cases.json (patch ${patchHash(patch).slice(0, 12)}).`,
      );
      out(
        'Nothing was applied. A publisher must review the patch and run `xo flow promote accept`. Agreement on past cases is not a measure of accuracy on new ones (not yet measured).',
      );
      return v.ok ? 0 : 2;
    }
    if (action === 'accept') {
      const [patchPath, keyPath, reviewer, dest] = ['patch', 'key', 'reviewer', 'out'].map((n) => flag(flags, n));
      if ([patchPath, keyPath, reviewer, dest].some((v) => v === undefined)) return fail(PROMOTE_USAGE);
      const patch = readJson<RulePatch>(patchPath as string);
      const acc = signPatchAcceptance(readFileSync(resolve(keyPath as string), 'utf8'), patch, reviewer as string);
      writeFileSync(resolve(dest as string), JSON.stringify(acc, null, 2));
      out(
        `signed acceptance of patch ${acc.patchHash.slice(0, 12)} as ${reviewer}. It is only honoured if ${reviewer} is a trusted, non-revoked publisher at apply time.`,
      );
      return 0;
    }
    if (action === 'apply') {
      const [patchPath, casesPath, accPath, revPath, dest] = ['patch', 'cases', 'acceptance', 'reviewers', 'out'].map((n) =>
        flag(flags, n),
      );
      if (file === undefined || [patchPath, casesPath, accPath, revPath, dest].some((v) => v === undefined)) return fail(PROMOTE_USAGE);
      const next = applyPatch(
        readJson<WorkflowComponent>(file),
        readJson<RulePatch>(patchPath as string),
        readJson<LoggedCase[]>(casesPath as string),
        readJson<PatchAcceptance>(accPath as string),
        new StaticReviewerRegistry(loadReviewerFile(resolve(revPath as string))),
      );
      writeFileSync(resolve(dest as string), JSON.stringify(next, null, 2));
      out(
        `wrote ${dest}: the next version of the workflow with the accepted rules first. It is not live: package, sign and install it like any XO version.`,
      );
      return 0;
    }
    return fail(PROMOTE_USAGE);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e)); // applyPatch refusals (no signature, wrong patch, untrusted signer…) end here with exit 1
  }
}
