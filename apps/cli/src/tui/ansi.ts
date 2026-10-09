/**
 * Terminal styling primitives for the interactive UI. Zero dependencies:
 * everything here is plain string manipulation over SGR escape codes.
 *
 * Two rules keep this safe to use anywhere in the CLI:
 *   1. A {@link Painter} at color level 0 returns its input unchanged, so
 *      code that styles text never needs an `if (color)` branch.
 *   2. Styling only ever *adds* escape sequences around existing text —
 *      `stripAnsi(style(x)) === x` — which is what lets the output
 *      highlighter (highlight.ts) colorize command output without being
 *      able to change what a command said.
 */

export type ColorLevel = 0 | 1 | 2 | 3;

export interface ColorEnv {
  readonly [key: string]: string | undefined;
}

export interface ColorStream {
  readonly isTTY?: boolean;
  getColorDepth?: () => number;
}

/**
 * NO_COLOR / FORCE_COLOR / TERM=dumb / TTY / COLORTERM detection, in the
 * precedence order most CLIs use: an explicit "off" always wins, an
 * explicit FORCE_COLOR level beats terminal sniffing, and a non-TTY
 * stream gets no color unless forced.
 */
export function detectColorLevel(stream: ColorStream, env: ColorEnv = process.env): ColorLevel {
  if ((env['NO_COLOR'] ?? '') !== '') return 0;
  const force = env['FORCE_COLOR'];
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0;
    if (force === '2') return 2;
    if (force === '3') return 3;
    return 1;
  }
  if (!stream.isTTY) return 0;
  if (env['TERM'] === 'dumb') return 0;
  const colorterm = (env['COLORTERM'] ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  const depth = stream.getColorDepth?.();
  if (depth !== undefined) {
    if (depth >= 24) return 3;
    if (depth >= 8) return 2;
    if (depth >= 4) return 1;
    return 0;
  }
  if ((env['TERM'] ?? '').includes('256color')) return 2;
  return 1;
}

const ESC = '\u001b';
export const RESET = `${ESC}[0m`;

const NAMED: Readonly<Record<string, number>> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97,
};

interface Rgb { readonly r: number; readonly g: number; readonly b: number }

function parseHex(hex: string): Rgb | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbTo256({ r, g, b }: Rgb): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const c = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

function rgbTo16Fg({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b);
  if (max < 60) return 30;
  const bright = max > 170;
  const bit = (v: number): number => (v > max * 0.6 ? 1 : 0);
  const code = bit(r) + bit(g) * 2 + bit(b) * 4; // 1=red 2=green 4=blue
  const base = code === 0 ? 7 : code; // washed-out grey -> white
  return (bright ? 90 : 30) + base;
}

export interface Painter {
  readonly level: ColorLevel;
  /** `color` is `#rrggbb` or a name from the ANSI palette (`red`, `gray`, ...). */
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
}

export function createPainter(level: ColorLevel): Painter {
  const wrap = (open: string, close: string, text: string): string => (level === 0 || text === '' ? text : `${ESC}[${open}m${text}${ESC}[${close}m`);

  const fgCode = (color: string): string | undefined => {
    const named = NAMED[color];
    if (named !== undefined) return String(named);
    const rgb = parseHex(color);
    if (!rgb) return undefined;
    if (level === 3) return `38;2;${rgb.r};${rgb.g};${rgb.b}`;
    if (level === 2) return `38;5;${rgbTo256(rgb)}`;
    return String(rgbTo16Fg(rgb));
  };
  const bgCode = (color: string): string | undefined => {
    const named = NAMED[color];
    if (named !== undefined) return String(named + 10);
    const rgb = parseHex(color);
    if (!rgb) return undefined;
    if (level === 3) return `48;2;${rgb.r};${rgb.g};${rgb.b}`;
    if (level === 2) return `48;5;${rgbTo256(rgb)}`;
    return String(rgbTo16Fg(rgb) + 10);
  };

  return {
    level,
    fg: (color, text) => {
      const code = fgCode(color);
      return code === undefined ? text : wrap(code, '39', text);
    },
    bg: (color, text) => {
      const code = bgCode(color);
      return code === undefined ? text : wrap(code, '49', text);
    },
    bold: (t) => wrap('1', '22', t),
    dim: (t) => wrap('2', '22', t),
    italic: (t) => wrap('3', '23', t),
    underline: (t) => wrap('4', '24', t),
    inverse: (t) => wrap('7', '27', t),
  };
}

/** Linear interpolation across `stops` (hex colors) at position `t` in [0,1]. */
export function gradientColor(stops: readonly string[], t: number): string {
  if (stops.length === 0) return '#ffffff';
  if (stops.length === 1) return stops[0]!;
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const a = parseHex(stops[i]!);
  const b = parseHex(stops[i + 1]!);
  if (!a || !b) return stops[i]!;
  const f = scaled - i;
  const mix = (x: number, y: number): string => Math.round(x + (y - x) * f).toString(16).padStart(2, '0');
  return `#${mix(a.r, b.r)}${mix(a.g, b.g)}${mix(a.b, b.b)}`;
}

// ---------------------------------------------------------------- measuring

const SGR_OR_OTHER_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(SGR_OR_OTHER_ESCAPE, '');
}

/** Terminal column width of one code point (0 for combining/zero-width, 2 for East Asian wide + emoji, else 1). */
export function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function visibleLength(text: string): number {
  let w = 0;
  for (const ch of stripAnsi(text)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

// ------------------------------------------------- styled-cell wrap/truncate

/** One visible character plus the SGR state active when it was printed. */
interface Cell {
  readonly ch: string;
  readonly w: number;
  readonly style: string;
}

function toCells(text: string): Cell[] {
  const cells: Cell[] = [];
  let style = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === ESC) {
      const m = /^\u001b\[([0-9;]*)m/.exec(text.slice(i, i + 40));
      if (m) {
        const params = m[1]!;
        style = params === '' || params === '0' ? '' : style + m[0];
        i += m[0].length;
        continue;
      }
      const other = /^(?:\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\))/.exec(text.slice(i));
      i += other ? other[0].length : 1;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    cells.push({ ch, w: charWidth(cp), style });
  }
  return cells;
}

function fromCells(cells: readonly Cell[]): string {
  let out = '';
  let active = '';
  for (const c of cells) {
    if (c.style !== active) {
      out += (active !== '' ? RESET : '') + c.style;
      active = c.style;
    }
    out += c.ch;
  }
  if (active !== '') out += RESET;
  return out;
}

/** Cuts `text` to at most `max` columns, appending `ellipsis` (which counts toward the limit) when anything was removed. */
export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (visibleLength(text) <= max) return text;
  const room = Math.max(0, max - visibleLength(ellipsis));
  const kept: Cell[] = [];
  let w = 0;
  for (const c of toCells(text)) {
    if (w + c.w > room) break;
    kept.push(c);
    w += c.w;
  }
  return fromCells(kept) + ellipsis;
}

/**
 * Word-wraps one (possibly styled) line to `width` columns. Breaks at
 * spaces where possible, hard-breaks over-long words, and re-opens the
 * active style at the start of each continuation line so a wrapped
 * colored span stays colored. Leading indentation is preserved on
 * continuation lines.
 */
export function wrapAnsi(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const cells = toCells(text);
  if (cells.reduce((n, c) => n + c.w, 0) <= width) return [fromCells(cells)];

  const indentCells = (() => {
    let n = 0;
    while (n < cells.length && cells[n]!.ch === ' ') n += 1;
    return n < width / 2 ? n : 0;
  })();
  const indent: Cell[] = cells.slice(0, indentCells).map((c) => ({ ...c }));

  const lines: string[] = [];
  let line: Cell[] = indent.map((c) => ({ ...c }));
  let lineW = indent.reduce((n, c) => n + c.w, 0);

  const flush = (): void => {
    while (line.length > 0 && line[line.length - 1]!.ch === ' ' && line.length > indent.length) line.pop();
    lines.push(fromCells(line));
    line = indent.map((c) => ({ ...c }));
    lineW = indent.reduce((n, c) => n + c.w, 0);
  };

  let i = indentCells;
  while (i < cells.length) {
    // Take the next word (a run of non-spaces) or a single space.
    let j = i;
    if (cells[i]!.ch === ' ') {
      j = i + 1;
    } else {
      while (j < cells.length && cells[j]!.ch !== ' ') j += 1;
    }
    const token = cells.slice(i, j);
    const tokenW = token.reduce((n, c) => n + c.w, 0);
    const lineHasContent = line.length > indent.length;

    if (token[0]!.ch === ' ') {
      if (lineHasContent && lineW + 1 <= width) {
        line.push(token[0]!);
        lineW += 1;
      }
    } else if (lineW + tokenW <= width) {
      line.push(...token);
      lineW += tokenW;
    } else if (tokenW <= width - indent.reduce((n, c) => n + c.w, 0) && lineHasContent) {
      flush();
      line.push(...token);
      lineW += tokenW;
      i = j;
      continue;
    } else {
      // Word longer than a whole line: hard-break it.
      for (const c of token) {
        if (lineW + c.w > width) flush();
        line.push(c);
        lineW += c.w;
      }
    }
    i = j;
  }
  if (line.length > indent.length || lines.length === 0) lines.push(fromCells(line));
  return lines;
}

/** Pads `text` with spaces on the right to exactly `width` visible columns (truncating if longer). */
export function padEnd(text: string, width: number): string {
  const len = visibleLength(text);
  if (len > width) return truncate(text, width);
  return text + ' '.repeat(width - len);
}
