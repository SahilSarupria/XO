import type { EnvironmentModel } from './environment-model.js';

/**
 * Plain-language summary for the future XO Connect experience (principle 4):
 * what was found, what was inspected, what is supported, what is uncertain,
 * and what access is still needed — without exposing graphs or connector
 * internals. Pure function of the model; adds no claims of its own.
 */
export function explainEnvironment(model: EnvironmentModel): string {
  const lines: string[] = [];
  const push = (s = ''): number => lines.push(s);
  for (const n of model.notices) push(`! ${n}`);
  push();
  push('What was found');
  if (model.systems.length === 0) push('  Nothing has been discovered yet.');
  for (const s of model.systems) {
    const counts = Object.entries(s.evidenceCountByKind)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    push(`  - ${s.displayName} (${s.sourceType}) is "${s.status.replaceAll('_', ' ')}"${counts ? `; evidence: ${counts}` : ''}`);
  }
  push();
  push('Relationships supported by evidence');
  if (model.relationships.length === 0) push('  None found.');
  for (const r of model.relationships) {
    push(`  - [${r.status.replaceAll('_', ' ')}] ${r.statement} (${r.from.resourceKey} <-> ${r.to.resourceKey}) — needs human review`);
  }
  push();
  push('Candidate processes (not validated)');
  if (model.processes.length === 0) push('  None proposed.');
  for (const p of model.processes) {
    push(
      `  - ${p.anchorIdentifier}: ${p.steps.length} related files; order ${p.order.established ? 'suggested by modified times only' : 'could not be determined'}; ${p.stepRelationship.replaceAll('_', ' ')}`,
    );
  }
  push();
  push('What XO is unsure about');
  if (model.unknowns.length === 0) push('  Nothing recorded.');
  for (const u of model.unknowns) push(`  - ${u.question} (${u.reason})`);
  push();
  push('Automation opportunities');
  push('  Not evaluated in this milestone. Candidate processes above are not executable and map to no validated capability.');
  push();
  push('Access or information still needed');
  const needing = model.systems.filter(
    (s) =>
      s.status === 'authorization_required' ||
      s.status === 'connection_required' ||
      s.status === 'unsupported_or_inaccessible' ||
      s.status === 'failed_or_unavailable',
  );
  if (needing.length === 0) push('  None for the sources inspected.');
  for (const s of needing) push(`  - ${s.displayName}: ${s.status.replaceAll('_', ' ')}`);
  return lines.join('\n');
}
