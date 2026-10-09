import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { compareReports, formatRegression, formatReport, loadSuiteFile, parseReport, runSuite, type BenchmarkReport } from '@xo/benchmark';
import { fail, failWith, type CommandResult } from '../../command-result.js';

export interface BenchmarkRunOptions {
  readonly suitePath: string;
  /** A previously written report to compare against. Exits non-zero on a regression. */
  readonly baselinePath?: string;
  /** Write the fresh report here (JSON). */
  readonly outPath?: string;
  /** Override the suite's `sourceRoot`. */
  readonly sourceRoot?: string;
  readonly json: boolean;
  /** Omit per-case sections from the text rendering. */
  readonly summaryOnly: boolean;
  readonly itemLimit?: number;
}

async function readReport(path: string): Promise<{ readonly ok: true; readonly report: BenchmarkReport } | { readonly ok: false; readonly message: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    return { ok: false, message: `cannot read report "${path}": ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const parsed = parseReport(raw);
  return parsed.ok ? { ok: true, report: parsed.value } : { ok: false, message: `"${path}" is not a benchmark report: ${parsed.message}` };
}

/**
 * `xo benchmark run <suite.json>` — runs the REAL pipeline over a suite's
 * cases and prints per-metric results. Exit codes:
 *
 *   0  the suite ran (metric shortfalls against ground truth are
 *      MEASUREMENTS, not command failures), and — if `--baseline` was
 *      given — no regression against it
 *   1  the definition/baseline is unreadable or invalid, a case could
 *      not be run by the harness, or `--baseline` shows a regression
 */
export async function benchmarkRunCommand(options: BenchmarkRunOptions): Promise<CommandResult> {
  const loaded = await loadSuiteFile(options.suitePath);
  if (!loaded.ok) {
    return fail([`error: ${loaded.message}`, ...loaded.issues.map((i) => `  ${i.path}: ${i.message}`)]);
  }
  let baseline: BenchmarkReport | undefined;
  if (options.baselinePath !== undefined) {
    const b = await readReport(options.baselinePath);
    if (!b.ok) return failWith(b.message);
    baseline = b.report;
  }

  const sourceRoot = options.sourceRoot !== undefined ? resolve(options.sourceRoot) : loaded.sourceRoot;
  const report = await runSuite(loaded.suite, { sourceRoot });

  if (options.outPath !== undefined) {
    await mkdir(dirname(resolve(options.outPath)), { recursive: true });
    await writeFile(options.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  const regression = baseline !== undefined ? compareReports(baseline, report) : undefined;
  const regressed = regression !== undefined && (regression.classification === 'regressed' || regression.classification === 'mixed');
  const lines: string[] = [];
  if (options.json) {
    lines.push(JSON.stringify(regression !== undefined ? { report, regression } : { report }, null, 2));
  } else {
    lines.push(formatReport(report, { perCase: !options.summaryOnly, ...(options.itemLimit !== undefined ? { itemLimit: options.itemLimit } : {}) }));
    if (regression !== undefined) lines.push('', formatRegression(regression));
    if (options.outPath !== undefined) lines.push('', `report written to ${options.outPath}`);
  }
  const exitCode = report.harnessErrorCount > 0 || regressed ? 1 : 0;
  return { exitCode, lines };
}

export interface BenchmarkCompareOptions {
  readonly baselinePath: string;
  readonly currentPath: string;
  readonly json: boolean;
}

/** `xo benchmark compare <baseline.json> <current.json>` — regression comparison of two written reports. Exit 1 on `regressed`/`mixed`. */
export async function benchmarkCompareCommand(options: BenchmarkCompareOptions): Promise<CommandResult> {
  const baseline = await readReport(options.baselinePath);
  if (!baseline.ok) return failWith(baseline.message);
  const current = await readReport(options.currentPath);
  if (!current.ok) return failWith(current.message);
  const regression = compareReports(baseline.report, current.report);
  const regressed = regression.classification === 'regressed' || regression.classification === 'mixed';
  return { exitCode: regressed ? 1 : 0, lines: [options.json ? JSON.stringify(regression, null, 2) : formatRegression(regression)] };
}
