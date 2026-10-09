import * as readline from 'node:readline';
import { charWidth, padEnd, truncate, visibleLength } from './ansi.js';
import type { History } from './history.js';
import type { Suggestion, SuggestionSet } from './completion.js';
import type { Ui } from './theme.js';

export interface EditorInput {
  on(event: 'keypress', listener: (str: string | undefined, key: readline.Key | undefined) => void): unknown;
  removeListener(event: 'keypress', listener: (str: string | undefined, key: readline.Key | undefined) => void): unknown;
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
}

export interface EditorOutput {
  write(chunk: string): unknown;
  readonly columns?: number | undefined;
  on?(event: 'resize', listener: () => void): unknown;
  removeListener?(event: 'resize', listener: () => void): unknown;
}

export interface FooterInfo {
  readonly left: string;
  readonly center: string;
  readonly right: string;
}

export interface EditorOptions {
  readonly input: EditorInput;
  readonly output: EditorOutput;
  readonly ui: () => Ui;
  readonly history: History;
  readonly suggest: (buffer: string, cursor: number) => SuggestionSet | undefined;
  readonly footer: () => FooterInfo;
  readonly now?: () => number;
}

export type ReadResult = { readonly kind: 'submit'; readonly text: string; readonly shell: boolean } | { readonly kind: 'exit' };

const MAX_MENU_ROWS = 8;
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** Wraps `buffer` into rows of at most `width` columns and locates the cursor. Exported for tests. */
export function layoutBuffer(buffer: string, cursor: number, width: number): { rows: string[]; cursorRow: number; cursorCol: number } {
  const rows: string[] = [''];
  let col = 0;
  let cursorRow = 0;
  let cursorCol = 0;
  let index = 0;
  for (const ch of buffer) {
    if (index === cursor) {
      cursorRow = rows.length - 1;
      cursorCol = col;
    }
    if (ch === '\n') {
      rows.push('');
      col = 0;
    } else {
      const w = charWidth(ch.codePointAt(0)!);
      if (col + w > width) {
        rows.push('');
        col = 0;
        if (index === cursor) {
          cursorRow = rows.length - 1;
          cursorCol = 0;
        }
      }
      rows[rows.length - 1] += ch;
      col += w;
    }
    index += ch.length;
  }
  if (cursor >= buffer.length) {
    if (col >= width) {
      rows.push('');
      col = 0;
    }
    cursorRow = rows.length - 1;
    cursorCol = col;
  }
  return { rows, cursorRow, cursorCol };
}

/**
 * The boxed prompt: a rounded input box with a live suggestion menu and a
 * status footer, redrawn in place on every keystroke. Persistent across
 * prompts (listeners attach once in {@link open}); the session alternates
 * between {@link read} (interactive editing) and {@link beginBusy} (a
 * command is running; only Ctrl+C is honored).
 *
 * Redraw technique: after each paint the terminal cursor rests on the
 * input row; the next paint moves up `prevCursorRow` lines to the top
 * of the block, clears to end of screen, and reprints. Every printed line
 * is at most the terminal width, so the row arithmetic stays exact.
 */
export class PromptEditor {
  private mode: 'idle' | 'reading' | 'busy' = 'idle';
  private buffer = '';
  private cursor = 0;
  private shellMode = false;
  private inPaste = false;
  private lastPasteWasNewline = false;
  private suggestions: SuggestionSet | undefined;
  private selected = 0;
  private suppressed = false;
  private notice: string | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private exitArmedUntil = 0;
  private prevCursorRow = 0;
  private resolveRead: ((r: ReadResult) => void) | undefined;
  private busyHandler: ((presses: number) => void) | undefined;
  private busyPresses = 0;
  private busyLastPress = 0;
  private opened = false;
  private readonly onResize = (): void => {
    if (this.mode === 'reading') this.paint(false);
  };

  constructor(private readonly options: EditorOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get columns(): number {
    return Math.max(24, this.options.output.columns ?? 80);
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    const { input, output } = this.options;
    readline.emitKeypressEvents(input as NodeJS.ReadableStream);
    if (input.isTTY) input.setRawMode?.(true);
    input.resume?.();
    input.on('keypress', this.onKeypress);
    output.write('\u001b[?2004h');
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    const { input, output } = this.options;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    input.removeListener('keypress', this.onKeypress);
    output.removeListener?.('resize', this.onResize);
    output.write('\u001b[?2004l\u001b[?25h');
    if (input.isTTY) input.setRawMode?.(false);
    input.pause?.();
  }

  /** Prompts once. `initial` pre-fills the buffer (used by `-i "<prompt>"`, which submits it immediately when `submitInitial` is set). */
  read(initial = ''): Promise<ReadResult> {
    if (this.mode === 'reading') return Promise.reject(new Error('PromptEditor.read() called while already reading'));
    this.open();
    this.mode = 'reading';
    this.buffer = initial;
    this.cursor = initial.length;
    this.shellMode = false;
    this.inPaste = false;
    this.suppressed = true;
    this.suggestions = undefined;
    this.selected = 0;
    this.notice = undefined;
    this.prevCursorRow = 0;
    this.options.history.resetNavigation();
    this.options.output.on?.('resize', this.onResize);
    this.paint(false);
    return new Promise((resolve) => {
      this.resolveRead = resolve;
    });
  }

  /** Enter "command running" mode: keys are swallowed except Ctrl+C, which reports how many times it was pressed within 3 seconds. */
  beginBusy(onInterrupt: (presses: number) => void): void {
    this.mode = 'busy';
    this.busyHandler = onInterrupt;
    this.busyPresses = 0;
    this.busyLastPress = 0;
  }

  endBusy(): void {
    this.mode = 'idle';
    this.busyHandler = undefined;
  }

  /** Clears the visible screen and any in-flight prompt geometry. */
  clearScreen(): void {
    this.options.output.write('\u001b[2J\u001b[3J\u001b[H');
    this.prevCursorRow = 0;
    if (this.mode === 'reading') this.paint(false);
  }

  // ------------------------------------------------------------- key input

  private readonly onKeypress = (str: string | undefined, key: readline.Key | undefined): void => {
    if (this.mode === 'busy') {
      if (key?.ctrl && key.name === 'c') {
        const t = this.now();
        this.busyPresses = t - this.busyLastPress > 3000 ? 1 : this.busyPresses + 1;
        this.busyLastPress = t;
        this.busyHandler?.(this.busyPresses);
      }
      return;
    }
    if (this.mode !== 'reading') return;
    this.handleKey(str, key ?? {});
  };

  private handleKey(str: string | undefined, key: readline.Key): void {
    const seq = key.sequence ?? str ?? '';
    if (seq === PASTE_START || (key.name as string | undefined) === 'paste-start') {
      this.inPaste = true;
      this.lastPasteWasNewline = false;
      return;
    }
    if (seq === PASTE_END || (key.name as string | undefined) === 'paste-end') {
      this.inPaste = false;
      this.afterEdit();
      return;
    }
    if (this.inPaste) {
      const isNewline = key.name === 'return' || key.name === 'enter';
      // A CRLF pair arrives as two keypresses; count it once.
      if (isNewline && this.lastPasteWasNewline) {
        this.lastPasteWasNewline = false;
        return;
      }
      this.lastPasteWasNewline = isNewline;
      if (isNewline) this.insert('\n');
      else if (key.name === 'tab') this.insert('    ');
      else if (str !== undefined) this.insert(str.replace(/\r\n?/g, '\n'));
      return; // repaint happens once, at paste end
    }

    const name = key.name;
    const ctrl = key.ctrl === true;
    const meta = key.meta === true;

    if (ctrl && name === 'c') return this.onCtrlC();
    if (ctrl && name === 'd') return this.onCtrlD();
    this.exitArmedUntil = 0;

    if (name === 'return') {
      if (meta) return this.editInsert('\n');
      return this.onEnter();
    }
    if (name === 'enter' || (ctrl && name === 'j')) return this.editInsert('\n');
    if (name === 'tab') return key.shift ? this.moveSelection(-1) : this.onTab();
    if (name === 'escape') return this.onEscape();
    if (name === 'backspace' || (ctrl && name === 'h')) return meta ? this.deleteWordBack() : this.backspace();
    if (name === 'delete') return this.deleteForward();
    if (name === 'left' || (ctrl && name === 'b')) return ctrl && name === 'left' ? this.moveWord(-1) : this.moveCursor(-1);
    if (name === 'right' || (ctrl && name === 'f')) return ctrl && name === 'right' ? this.moveWord(1) : this.moveCursor(1);
    if (meta && name === 'b') return this.moveWord(-1);
    if (meta && name === 'f') return this.moveWord(1);
    if (name === 'home' || (ctrl && name === 'a')) return this.moveLineEdge(-1);
    if (name === 'end' || (ctrl && name === 'e')) return this.moveLineEdge(1);
    if (name === 'up' || (ctrl && name === 'p')) return this.onUp();
    if (name === 'down' || (ctrl && name === 'n')) return this.onDown();
    if (ctrl && name === 'u') return this.killToLineStart();
    if (ctrl && name === 'k') return this.killToLineEnd();
    if (ctrl && name === 'w') return this.deleteWordBack();
    if (ctrl && name === 'l') return this.clearScreen();

    if (ctrl || meta || str === undefined || str === '') return;
    // Printable input (possibly several characters if the terminal batched them).
    if (str === '!' && this.buffer === '' && !this.shellMode) {
      this.shellMode = true;
      this.paint(false);
      return;
    }
    this.editInsert(str.replace(/\t/g, '    '));
  }

  // ------------------------------------------------------------- editing

  private sanitize(text: string): string {
    // Keep newlines, drop other control characters that would corrupt the layout.
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
  }

  private insert(text: string): void {
    const clean = this.sanitize(text);
    if (clean === '') return;
    this.buffer = this.buffer.slice(0, this.cursor) + clean + this.buffer.slice(this.cursor);
    this.cursor += clean.length;
  }

  private editInsert(text: string): void {
    this.insert(text);
    this.afterEdit();
  }

  private afterEdit(): void {
    this.suppressed = false;
    this.refreshSuggestions();
    this.paint(false);
  }

  private refreshSuggestions(): void {
    this.suggestions = this.suppressed || this.shellMode ? undefined : this.options.suggest(this.buffer, this.cursor);
    this.selected = 0;
  }

  private backspace(): void {
    if (this.cursor === 0) {
      if (this.buffer === '' && this.shellMode) {
        this.shellMode = false;
        this.paint(false);
      }
      return;
    }
    const prev = this.prevIndex(this.cursor);
    this.buffer = this.buffer.slice(0, prev) + this.buffer.slice(this.cursor);
    this.cursor = prev;
    this.afterEdit();
  }

  private deleteForward(): void {
    if (this.cursor >= this.buffer.length) return;
    const next = this.nextIndex(this.cursor);
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(next);
    this.afterEdit();
  }

  private prevIndex(i: number): number {
    if (i <= 0) return 0;
    const low = this.buffer.charCodeAt(i - 1);
    return low >= 0xdc00 && low <= 0xdfff && i >= 2 ? i - 2 : i - 1;
  }

  private nextIndex(i: number): number {
    if (i >= this.buffer.length) return this.buffer.length;
    const high = this.buffer.charCodeAt(i);
    return high >= 0xd800 && high <= 0xdbff ? i + 2 : i + 1;
  }

  private wordBoundary(from: number, dir: -1 | 1): number {
    let i = from;
    const isSpace = (idx: number): boolean => /\s/.test(this.buffer[idx] ?? ' ');
    if (dir === -1) {
      while (i > 0 && isSpace(i - 1)) i -= 1;
      while (i > 0 && !isSpace(i - 1)) i -= 1;
    } else {
      while (i < this.buffer.length && isSpace(i)) i += 1;
      while (i < this.buffer.length && !isSpace(i)) i += 1;
    }
    return i;
  }

  private deleteWordBack(): void {
    const start = this.wordBoundary(this.cursor, -1);
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
    this.cursor = start;
    this.afterEdit();
  }

  private killToLineStart(): void {
    const start = this.buffer.lastIndexOf('\n', this.cursor - 1) + 1;
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
    this.cursor = start;
    this.afterEdit();
  }

  private killToLineEnd(): void {
    let end = this.buffer.indexOf('\n', this.cursor);
    if (end === -1) end = this.buffer.length;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(end);
    this.afterEdit();
  }

  private moveCursor(delta: -1 | 1): void {
    this.cursor = delta < 0 ? this.prevIndex(this.cursor) : this.nextIndex(this.cursor);
    this.afterCursorMove();
  }

  private moveWord(dir: -1 | 1): void {
    this.cursor = this.wordBoundary(this.cursor, dir);
    this.afterCursorMove();
  }

  private moveLineEdge(dir: -1 | 1): void {
    if (dir < 0) this.cursor = this.buffer.lastIndexOf('\n', this.cursor - 1) + 1;
    else {
      const end = this.buffer.indexOf('\n', this.cursor);
      this.cursor = end === -1 ? this.buffer.length : end;
    }
    this.afterCursorMove();
  }

  private afterCursorMove(): void {
    this.suppressed = false;
    this.refreshSuggestions();
    this.paint(false);
  }

  // ------------------------------------------------------------- actions

  private menuItems(): readonly Suggestion[] {
    return !this.suppressed && this.suggestions ? this.suggestions.items : [];
  }

  private moveSelection(delta: number): void {
    const items = this.menuItems();
    if (items.length === 0) return;
    this.selected = (this.selected + delta + items.length) % items.length;
    this.paint(false);
  }

  private accept(item: Suggestion): void {
    const set = this.suggestions;
    if (!set) return;
    this.buffer = this.buffer.slice(0, set.from) + item.insert + this.buffer.slice(set.to);
    this.cursor = set.from + item.insert.length;
    this.afterEdit();
    // A finished file/value needs no follow-up menu; a command name (or a directory) does.
    if ((item.kind === 'path' || item.kind === 'value') && item.complete) {
      this.suppressed = true;
      this.suggestions = undefined;
      this.paint(false);
    }
  }

  private onTab(): void {
    const items = this.menuItems();
    const item = items[this.selected];
    if (item) this.accept(item);
  }

  private onUp(): void {
    const items = this.menuItems();
    if (items.length > 0) return this.moveSelection(-1);
    const lineStart = this.buffer.lastIndexOf('\n', this.cursor - 1) + 1;
    if (lineStart > 0) {
      // Move within a multi-line buffer.
      const col = this.cursor - lineStart;
      const prevStart = this.buffer.lastIndexOf('\n', lineStart - 2) + 1;
      this.cursor = Math.min(prevStart + col, lineStart - 1);
      this.paint(false);
      return;
    }
    const entry = this.options.history.previous(this.buffer);
    if (entry !== undefined) this.replaceBuffer(entry);
  }

  private onDown(): void {
    const items = this.menuItems();
    if (items.length > 0) return this.moveSelection(1);
    const lineEnd = this.buffer.indexOf('\n', this.cursor);
    if (lineEnd !== -1) {
      const lineStart = this.buffer.lastIndexOf('\n', this.cursor - 1) + 1;
      const col = this.cursor - lineStart;
      let nextEnd = this.buffer.indexOf('\n', lineEnd + 1);
      if (nextEnd === -1) nextEnd = this.buffer.length;
      this.cursor = Math.min(lineEnd + 1 + col, nextEnd);
      this.paint(false);
      return;
    }
    const entry = this.options.history.next();
    if (entry !== undefined) this.replaceBuffer(entry);
  }

  private replaceBuffer(entry: string): void {
    // History stores shell-mode lines with their leading "!".
    const text = entry.startsWith('!') ? entry.slice(1) : entry;
    this.shellMode = entry.startsWith('!');
    this.buffer = text;
    this.cursor = text.length;
    this.suppressed = true; // no menu popping up while browsing history
    this.suggestions = undefined;
    this.paint(false);
  }

  private onEscape(): void {
    if (this.menuItems().length > 0) {
      this.suppressed = true;
      this.suggestions = undefined;
      this.paint(false);
    } else if (this.shellMode) {
      this.shellMode = false;
      this.paint(false);
    }
  }

  private onEnter(): void {
    const items = this.menuItems();
    const item = items[this.selected];
    if (item && item.kind === 'command' && this.suggestions) {
      const typed = this.buffer.slice(this.suggestions.from, this.suggestions.to);
      if (item.insert.trimEnd() !== typed.trimEnd()) {
        this.accept(item);
        if (item.runOnEnter) this.submit();
        return;
      }
    }
    // Trailing backslash continues the line instead of submitting.
    if (this.cursor === this.buffer.length && this.buffer.endsWith('\\') && !this.buffer.endsWith('\\\\')) {
      this.buffer = `${this.buffer.slice(0, -1)}\n`;
      this.cursor = this.buffer.length;
      this.afterEdit();
      return;
    }
    this.submit();
  }

  private submit(): void {
    const text = this.buffer;
    const shell = this.shellMode;
    this.paint(true);
    this.finishRead({ kind: 'submit', text, shell });
  }

  private onCtrlC(): void {
    if (this.buffer !== '') {
      this.buffer = '';
      this.cursor = 0;
      this.suppressed = true;
      this.suggestions = undefined;
      this.paint(false);
      return;
    }
    if (this.shellMode) {
      this.shellMode = false;
      this.paint(false);
      return;
    }
    this.armExit('Press Ctrl+C again to exit.');
  }

  private onCtrlD(): void {
    if (this.buffer === '') return this.armExit('Press Ctrl+D again to exit.');
    this.deleteForward();
  }

  private armExit(message: string): void {
    if (this.exitArmedUntil > this.now()) {
      this.paint(false);
      this.finishRead({ kind: 'exit' });
      return;
    }
    this.exitArmedUntil = this.now() + 2000;
    this.setNotice(message, 2000);
  }

  private setNotice(text: string, ms: number): void {
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = undefined;
      this.exitArmedUntil = 0;
      if (this.mode === 'reading') this.paint(false);
    }, ms);
    this.noticeTimer.unref();
    this.paint(false);
  }

  private finishRead(result: ReadResult): void {
    const resolve = this.resolveRead;
    this.resolveRead = undefined;
    this.mode = 'idle';
    this.options.output.removeListener?.('resize', this.onResize);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.notice = undefined;
    // Park the cursor on the line below the block so command output starts cleanly.
    if (this.lastLineCount > 0) {
      const down = this.lastLineCount - 1 - this.prevCursorRow;
      this.options.output.write(`${down > 0 ? `\u001b[${down}B` : ''}\r\n`);
    }
    this.lastLineCount = 0;
    this.prevCursorRow = 0;
    if (result.kind === 'submit') this.options.history.add(result.shell ? `!${result.text}` : result.text);
    resolve?.(result);
  }

  // ------------------------------------------------------------- painting

  private lastLineCount = 0;

  private paint(final: boolean): void {
    const ui = this.options.ui();
    const cols = this.columns;
    const inner = cols - 4;
    const promptWidth = 2;
    const textWidth = inner - promptWidth;
    const layout = layoutBuffer(this.buffer, this.cursor, textWidth);

    const active = !final;
    const borderColor = final ? ui.theme.border : this.shellMode ? ui.theme.shell : active ? ui.theme.borderActive : ui.theme.border;
    const b = (s: string): string => ui.painter.fg(borderColor, s);
    const promptGlyph = this.shellMode ? ui.painter.bold(ui.painter.fg(ui.theme.shell, '!')) : ui.painter.bold(ui.primary('>'));

    const lines: string[] = [];
    lines.push(b(`╭${'─'.repeat(cols - 2)}╮`));

    if (this.buffer === '') {
      const hint = this.shellMode ? 'Shell mode: type a command (Esc or Backspace to exit)' : 'Type / for commands, @ for files, or ask your installed XOs';
      lines.push(`${b('│')} ${promptGlyph} ${padEnd(ui.muted(truncate(hint, textWidth)), textWidth)} ${b('│')}`);
    } else {
      layout.rows.forEach((row, i) => {
        const lead = i === 0 ? `${promptGlyph} ` : '  ';
        lines.push(`${b('│')} ${lead}${padEnd(final ? ui.muted(row) : row, textWidth)} ${b('│')}`);
      });
    }
    lines.push(b(`╰${'─'.repeat(cols - 2)}╯`));

    const firstRowOffset = 1; // top border
    const cursorRowAbs = firstRowOffset + (this.buffer === '' ? 0 : layout.cursorRow);
    const cursorCol = 1 + 1 + promptWidth + (this.buffer === '' ? 0 : layout.cursorCol);

    if (!final) {
      lines.push(...this.renderMenu(ui, cols));
      lines.push(this.renderFooter(ui, cols));
    }

    let out = '';
    if (this.prevCursorRow > 0) out += `\u001b[${this.prevCursorRow}A`;
    out += '\r\u001b[J';
    out += lines.join('\n');
    const up = lines.length - 1 - cursorRowAbs;
    if (up > 0) out += `\u001b[${up}A`;
    out += `\r${cursorCol > 0 ? `\u001b[${cursorCol}C` : ''}`;
    this.options.output.write(out);

    this.prevCursorRow = cursorRowAbs;
    this.lastLineCount = lines.length;
  }

  private renderMenu(ui: Ui, cols: number): string[] {
    const items = this.menuItems();
    if (items.length === 0) return [];
    const total = items.length;
    const windowSize = Math.min(MAX_MENU_ROWS, total);
    let start = Math.max(0, Math.min(this.selected - Math.floor(windowSize / 2), total - windowSize));
    if (start < 0) start = 0;
    const visible = items.slice(start, start + windowSize);
    const labelWidth = Math.min(Math.floor(cols * 0.45), Math.max(...visible.map((i) => visibleLength(i.label))) + 2);

    const rows = visible.map((item, i) => {
      const isSel = start + i === this.selected;
      const marker = isSel ? ui.primary('▸') : ' ';
      const label = padEnd(isSel ? ui.painter.bold(ui.primary(item.label)) : ui.accent(item.label), labelWidth);
      const desc = item.description ? ui.muted(item.description) : '';
      return truncate(` ${marker} ${label} ${desc}`, cols - 1);
    });
    if (total > windowSize) rows.push(truncate(ui.muted(`   (${this.selected + 1}/${total}) ↑↓ to navigate · Tab to accept · Esc to dismiss`), cols - 1));
    return rows;
  }

  private renderFooter(ui: Ui, cols: number): string {
    const info = this.options.footer();
    const center = this.notice !== undefined ? ui.warning(this.notice) : ui.muted(info.center);
    const left = ui.muted(info.left);
    const right = ui.muted(info.right);
    const usable = cols - 2;
    const lw = visibleLength(left);
    const cw = visibleLength(center);
    const rw = visibleLength(right);
    if (lw + cw + rw + 4 > usable) {
      // Too narrow: drop the center, then the right.
      const compact = rw > 0 && lw + rw + 2 <= usable ? `${left}${' '.repeat(usable - lw - rw)}${right}` : left;
      return ` ${truncate(compact, usable)}`;
    }
    const gapTotal = usable - lw - cw - rw;
    const leftGap = Math.floor(gapTotal / 2);
    return ` ${left}${' '.repeat(leftGap)}${center}${' '.repeat(gapTotal - leftGap)}${right}`;
  }
}
