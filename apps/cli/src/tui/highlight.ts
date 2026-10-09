import type { Ui } from './theme.js';

/**
 * Colorizes the plain-text output existing commands already produce.
 *
 * Commands stay exactly as they are — they print `error: ...`, `[PASS]
 * schema`, `Key: value`, JSON — and this module recognizes those shapes
 * after the fact. The single invariant, enforced by test: for every
 * non-JSON line, `stripAnsi(highlightLine(x)) === x`. Highlighting can
 * add color; it can never reword, reorder, or drop anything a command
 * reported. (The one deliberate exception is compact one-line JSON,
 * which is pretty-printed for display — `--json` output stays exactly
 * as emitted in one-shot mode; only the interactive session expands it.)
 */

const STATUS_BAD = /\b(MISSING|UNRESOLVED|UNSAFE|INVALID|FAILED|BLOCKED|FAIL)\b/g;
const STATUS_GOOD = /\b(VALID|SAFE|PASS)\b/g;
const STATUS_WARN = /\b(WARN)\b/g;
const HEADINGS = new Set(['Source', 'Understanding', 'Capability classification', 'Execution', 'Final summary']);

function styleWords(text: string, ui: Ui): string {
  if (ui.painter.level === 0 || text === '') return text;
  return text
    .replace(/(->\s+)(injected|supplied)\b/g, (_m, arrow: string, word: string) => arrow + ui.success(word))
    .replace(/\b(escalation_required|waiting_for_human)\b/g, (w) => ui.warning(w))
    .replace(STATUS_BAD, (w) => ui.error(w))
    .replace(STATUS_GOOD, (w) => ui.success(w))
    .replace(STATUS_WARN, (w) => ui.warning(w))
    .replace(/\bsha256:[0-9a-f]{16,}\b/g, (h) => ui.muted(h));
}

function colorJsonValue(raw: string, ui: Ui): string {
  const trailing = raw.endsWith(',') ? ',' : '';
  const v = trailing ? raw.slice(0, -1) : raw;
  let out: string;
  if (/^"(?:[^"\\]|\\.)*"$/.test(v)) out = ui.success(v);
  else if (/^-?\d[\d.eE+-]*$/.test(v)) out = ui.warning(v);
  else if (v === 'true' || v === 'false') out = ui.primary(v);
  else if (v === 'null') out = ui.muted(v);
  else out = ui.muted(v);
  return out + trailing;
}

function colorJsonLine(line: string, ui: Ui): string {
  const keyed = /^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/.exec(line);
  if (keyed) return `${keyed[1]}${ui.accent(keyed[2]!)}${keyed[3]}${colorJsonValue(keyed[4]!, ui)}`;
  const bare = /^(\s*)(.*)$/.exec(line)!;
  return `${bare[1]}${colorJsonValue(bare[2]!, ui)}`;
}

function tryParseJsonLine(line: string): unknown | undefined {
  const t = line.trim();
  if (t.length < 2 || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    const value: unknown = JSON.parse(t);
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Colors one non-JSON line. `stripAnsi(result) === line` always. */
export function highlightLine(line: string, ui: Ui): string {
  if (ui.painter.level === 0 || line === '') return line;

  let m: RegExpExecArray | null;

  if ((m = /^(\s*)(error:)(.*)$/.exec(line))) return `${m[1]}${ui.painter.bold(ui.error(m[2]!))}${ui.error(m[3]!)}`;
  if ((m = /^(\s*)(warning:|note:)(.*)$/.exec(line))) return `${m[1]}${ui.painter.bold(ui.warning(m[2]!))}${m[3]}`;
  if (/^\s*(?:={5,}|-{5,}|─{5,})\s*$/.test(line) || /^\s*---.*---\s*$/.test(line)) return ui.muted(line);
  if ((m = /^(\s*)\[(PASS|FAIL|WARN)\](.*)$/.exec(line))) {
    const color = m[2] === 'PASS' ? ui.success : m[2] === 'FAIL' ? ui.error : ui.warning;
    return `${m[1]}${ui.painter.bold(color(`[${m[2]}]`))}${m[3]}`;
  }
  if (/^(VALID|SAFE)$/.test(line)) return ui.painter.bold(ui.success(line));
  if (/^(INVALID|UNSAFE)$/.test(line)) return ui.painter.bold(ui.error(line));
  if ((m = /^(ok)(\s{2}.*)$/.exec(line))) return `${ui.success(m[1]!)}${m[2]}`;
  if ((m = /^(FAIL)(\s{2}.*)$/.exec(line))) return `${ui.painter.bold(ui.error(m[1]!))}${m[2]}`;
  if (HEADINGS.has(line) || /^[A-Z][^\n]{0,60}:$/.test(line)) return ui.painter.bold(ui.primary(line));
  if (/^\s*"(?:[^"\\]|\\.)*"\s*:/.test(line)) return colorJsonLine(line, ui);
  if ((m = /^(\s*(?:- )?)([A-Za-z_][\w .()/[\]-]{0,38}?)(:)(\s+)(\S.*)$/.exec(line))) {
    return `${m[1]}${ui.muted(m[2]!)}${m[3]}${m[4]}${styleWords(m[5]!, ui)}`;
  }
  return styleWords(line, ui);
}

/** Splits `text` into display lines: single-line JSON is pretty-printed and colored, everything else goes through {@link highlightLine}. */
export function highlightOutput(text: string, ui: Ui): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const json = tryParseJsonLine(raw);
    if (json !== undefined) {
      for (const pretty of JSON.stringify(json, null, 2).split('\n')) out.push(colorJsonLine(pretty, ui));
    } else {
      out.push(highlightLine(raw, ui));
    }
  }
  // Drop the single trailing empty line a final "\n" produces.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}
