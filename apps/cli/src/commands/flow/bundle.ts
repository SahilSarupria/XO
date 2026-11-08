import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrees, type DecisionTree } from '@xo/capability-layer';
import { unpackArchive, type PackageBundle, type PackageTrustPolicy } from '@xo/package-sdk';
import { err, ok, type Result } from '@xo/types';
import { loadWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import { resolveTrustValidator } from '../../package-trust.js';

export interface LoadedWorkflowBundle {
  readonly bundle: PackageBundle;
  readonly component: WorkflowComponent;
  readonly trees: readonly DecisionTree[];
  /** One line saying how the package was admitted; `unverified [mode=development]` is never dressed up as trust. */
  readonly trust: string;
  /** Non-empty exactly in explicit development mode. */
  readonly warnings: readonly string[];
}

/** A `.xo` file, or a directory holding exactly one `.xo` (so a release directory can be named without guessing which file). */
function archivePathOf(path: string): Result<string, string> {
  const p = resolve(path);
  let st;
  try {
    st = statSync(p);
  } catch {
    return err(`--bundle ${path}: no such file or directory`);
  }
  if (st.isFile()) return ok(p);
  const archives = readdirSync(p).filter((f) => f.endsWith('.xo'));
  if (archives.length !== 1) return err(`--bundle ${path}: a directory must contain exactly one .xo file (found ${archives.length})`);
  return ok(join(p, archives[0]!));
}

/**
 * Loads the workflows and decision trees of a signed package, for running or serving. Everything the running system will use comes from the VERIFIED
 * package, never from loose files next to it:
 *   1. the archive unpacks, and its structure, component hashes and Merkle root validate;
 *   2. the operator's trust policy (the same one install/verify/run use) accepts it. With no policy configured this FAILS CLOSED; `XO_TRUST_MODE=development`
 *      is the only way to run an unverified package and it is announced in every output;
 *   3. the workflow component is validated against exactly the decision trees the package ships (`validateAgainstBundle`).
 */
export async function loadWorkflowBundle(path: string, injectedPolicy?: PackageTrustPolicy): Promise<Result<LoadedWorkflowBundle, string>> {
  const archive = archivePathOf(path);
  if (!archive.ok) return archive;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(archive.value));
  } catch (e) {
    return err(`could not read ${archive.value}: ${(e as Error).message}`);
  }
  const unpacked = await unpackArchive(bytes);
  if (!unpacked.ok) return err(`${archive.value} is not a valid package: ${unpacked.error.message}`);
  const bundle = unpacked.value;

  const trust = resolveTrustValidator(injectedPolicy);
  if (!trust.ok) return err(trust.message);
  const report = trust.validator.validateAll(bundle);
  if (!report.valid) {
    const errors = report.issues.filter((i) => i.severity === 'error').slice(0, 5);
    return err(`package failed validation: ${errors.map((i) => `${i.code}: ${i.message}`).join('; ')}`);
  }
  const verdict = trust.validator.evaluateTrust(bundle.manifest);
  if (!verdict.acceptable)
    return err(
      `package is not trusted by the operator policy (${verdict.status}${verdict.failures.length > 0 ? `: ${verdict.failures.map((f) => f.message).join('; ')}` : ''})`,
    );

  const bytesOf = (path: string): Uint8Array | undefined => bundle.components.find((c) => c.path === path)?.data;
  const wfBytes = bytesOf('workflows/workflows.json');
  if (wfBytes === undefined)
    return err(
      'the package has no workflows component (compile a policy with `xo create`, or run loose files with `xo flow run <workflows.json>`)',
    );
  let trees: DecisionTree[] = [];
  const treeBytes = bytesOf('reasoning/decision_trees.json');
  if (treeBytes !== undefined) trees = parseTrees(JSON.parse(Buffer.from(treeBytes).toString('utf8'))) ?? [];
  try {
    const loaded = loadWorkflowComponent(wfBytes, { decisionTrees: { trees } });
    return ok({
      bundle,
      component: loaded.component,
      trees,
      trust: `${verdict.status} [mode=${verdict.mode}]${verdict.signers.length > 0 ? ` signers: ${verdict.signers.map((s) => `${s.signerDid}/${s.role}`).join(', ')}` : ''}`,
      warnings: trust.warnings,
    });
  } catch (e) {
    return err(`the package's workflows do not validate: ${(e as Error).message}`);
  }
}
