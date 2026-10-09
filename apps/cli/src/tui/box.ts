import { padEnd, truncate, visibleLength, wrapAnsi } from './ansi.js';
import type { Ui } from './theme.js';

export interface BoxOptions {
  /** Total width including borders. */
  readonly width: number;
  /** Already-styled title text placed in the top border. */
  readonly title?: string;
  /** Already-styled text right-aligned in the bottom border (e.g. a duration). */
  readonly footer?: string;
  /** Painter for the border glyphs themselves. */
  readonly borderColor: (text: string) => string;
}

/**
 * Rounded-corner box around already-styled lines. Content is word-wrapped
 * to the inner width (width - 4: border + one space of padding each
 * side), so every returned line is exactly `width` columns — the
 * invariant the prompt editor's cursor arithmetic depends on.
 */
export function renderBox(lines: readonly string[], options: BoxOptions): string[] {
  const width = Math.max(10, options.width);
  const inner = width - 4;
  const b = options.borderColor;

  const top = (() => {
    if (options.title === undefined || options.title === '') return b(`╭${'─'.repeat(width - 2)}╮`);
    const title = truncate(options.title, Math.max(1, width - 6));
    const fill = Math.max(0, width - 5 - visibleLength(title));
    return `${b('╭─')} ${title} ${b(`${'─'.repeat(fill)}╮`)}`;
  })();

  const bottom = (() => {
    if (options.footer === undefined || options.footer === '') return b(`╰${'─'.repeat(width - 2)}╯`);
    const footer = truncate(options.footer, Math.max(1, width - 6));
    const fill = Math.max(0, width - 5 - visibleLength(footer));
    return `${b(`╰${'─'.repeat(fill)}`)} ${footer} ${b('─╯')}`;
  })();

  const body: string[] = [];
  for (const line of lines) {
    for (const wrapped of wrapAnsi(line, inner)) body.push(`${b('│')} ${padEnd(wrapped, inner)} ${b('│')}`);
  }
  if (body.length === 0) body.push(`${b('│')} ${' '.repeat(inner)} ${b('│')}`);
  return [top, ...body, bottom];
}

/** Convenience used by the REPL: a titled box in the theme's border color. */
export function themedBox(ui: Ui, lines: readonly string[], width: number, title?: string, footer?: string, active = false): string[] {
  const border = active ? ui.theme.borderActive : ui.theme.border;
  return renderBox(lines, {
    width,
    ...(title !== undefined ? { title } : {}),
    ...(footer !== undefined ? { footer } : {}),
    borderColor: (t) => ui.painter.fg(border, t),
  });
}
