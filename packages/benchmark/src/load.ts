import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateSuiteDefinition, type BenchmarkSuiteDefinition, type DefinitionIssue } from './definition.js';

export type LoadSuiteResult =
  | { readonly ok: true; readonly suite: BenchmarkSuiteDefinition; readonly sourceRoot: string }
  | { readonly ok: false; readonly message: string; readonly issues: readonly DefinitionIssue[] };

/** Reads and validates a suite file. `sourceRoot` = the suite's `sourceRoot` resolved against the suite file's directory (default: that directory). */
export async function loadSuiteFile(path: string): Promise<LoadSuiteResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    return { ok: false, message: `cannot read suite file "${path}": ${cause instanceof Error ? cause.message : String(cause)}`, issues: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { ok: false, message: `suite file "${path}" is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, issues: [] };
  }
  const validated = validateSuiteDefinition(raw);
  if (!validated.ok) return { ok: false, message: `suite file "${path}" is not a valid benchmark definition (${validated.issues.length} issue(s))`, issues: validated.issues };
  return { ok: true, suite: validated.value, sourceRoot: resolve(dirname(path), validated.value.sourceRoot ?? '.') };
}
