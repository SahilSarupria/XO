import type { Ui } from './theme.js';
import { truncate } from './ansi.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Rotated while a command runs — cosmetic only, and switched off by `wittyPhrases: false` in settings. */
export const WITTY_PHRASES: readonly string[] = [
  'Reading the fine print…',
  'Extracting semantic knowledge…',
  'Untangling clause dependencies…',
  'Cross-referencing the exclusions…',
  'Linking capabilities to rules…',
  'Walking the XOIR graph…',
  'Hashing the Merkle tree…',
  'Asking the runtime nicely…',
  'Aligning concepts across sources…',
  'Convincing the compiler it is not Friday…',
];

export interface SpinnerOptions {
  readonly ui: Ui;
  /** Writes raw text to the terminal (never through the captured stdout). */
  readonly write: (text: string) => void;
  readonly columns: () => number;
  /** False on non-TTY output: start/stop become no-ops so pipes never see control codes. */
  readonly enabled: boolean;
  readonly witty: boolean;
  readonly now?: () => number;
  readonly random?: () => number;
}

export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private startedAt = 0;
  private label = '';
  private phrase = '';
  private phraseAt = 0;
  private note: string | undefined;

  constructor(private readonly options: SpinnerOptions) {}

  start(label: string): void {
    if (!this.options.enabled || this.timer) return;
    const now = this.options.now ?? Date.now;
    this.label = label;
    this.startedAt = now();
    this.pickPhrase(true);
    this.options.write('\u001b[?25l');
    this.tick();
    this.timer = setInterval(() => this.tick(), 80);
    this.timer.unref();
  }

  /** Replaces the default `ctrl+c twice to quit` hint (e.g. after the first Ctrl+C). */
  setNote(note: string | undefined): void {
    this.note = note;
  }

  stop(): void {
    this.note = undefined;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.options.write('\r\u001b[2K\u001b[?25h');
  }

  private pickPhrase(force: boolean): void {
    const now = (this.options.now ?? Date.now)();
    if (!force && now - this.phraseAt < 6000) return;
    this.phraseAt = now;
    if (!this.options.witty) {
      this.phrase = `Running ${this.label}…`;
      return;
    }
    const rnd = this.options.random ?? Math.random;
    this.phrase = WITTY_PHRASES[Math.floor(rnd() * WITTY_PHRASES.length)] ?? WITTY_PHRASES[0]!;
  }

  private tick(): void {
    const { ui } = this.options;
    this.pickPhrase(false);
    const elapsed = Math.max(0, Math.floor(((this.options.now ?? Date.now)() - this.startedAt) / 1000));
    const frame = FRAMES[this.frame % FRAMES.length]!;
    this.frame += 1;
    const hint = ui.muted(`(${this.label} · ${elapsed}s · ${this.note ?? 'ctrl+c twice to quit'})`);
    const line = `${ui.primary(frame)} ${ui.accent(this.phrase)} ${hint}`;
    this.options.write(`\r\u001b[2K${truncate(line, Math.max(10, this.options.columns() - 1))}`);
  }
}
