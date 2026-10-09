import type { Ui } from './theme.js';

/**
 * A deliberately small markdown renderer for model responses shown in the
 * interactive session: headings, bullets, numbered lists, block quotes,
 * fenced code, and inline `code` / **bold** / *italic*. Anything it does
 * not recognize is passed through as-is — it never drops text.
 */
export function renderMarkdown(text: string, ui: Ui): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(ui.muted(inFence ? `┌─ ${line.trim().slice(3).trim() || 'code'}` : '└─'));
      continue;
    }
    if (inFence) {
      out.push(`${ui.muted('│')} ${ui.accent(line)}`);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      out.push(ui.painter.bold(ui.primary(m[2]!)));
    } else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
      out.push(`${m[1]}${ui.accent('•')} ${inline(m[2]!, ui)}`);
    } else if ((m = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line))) {
      out.push(`${m[1]}${ui.accent(m[2]!)} ${inline(m[3]!, ui)}`);
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      out.push(`${ui.muted('▎')} ${ui.painter.italic(inline(m[1]!, ui))}`);
    } else {
      out.push(inline(line, ui));
    }
  }
  return out;
}

function inline(text: string, ui: Ui): string {
  if (ui.painter.level === 0) return text;
  return text
    .replace(/`([^`]+)`/g, (_m, code: string) => ui.accent(code))
    .replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => ui.painter.bold(b))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, (_m, pre: string, i: string) => pre + ui.painter.italic(i));
}
