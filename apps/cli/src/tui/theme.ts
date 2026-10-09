import type { Painter } from './ansi.js';

/**
 * Semantic color tokens. UI code asks for "success" or "border", never
 * for a literal color, so `/theme` can restyle everything at once.
 * Values are `#rrggbb` (downsampled automatically on 256/16-color
 * terminals by the {@link Painter}) or an ANSI palette name (`ansi`
 * theme — respects the user's own terminal palette).
 */
export interface Theme {
  readonly name: string;
  readonly description: string;
  readonly primary: string;
  readonly accent: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly muted: string;
  readonly border: string;
  readonly borderActive: string;
  readonly shell: string;
  /** Top-to-bottom stops for the startup banner. */
  readonly gradient: readonly string[];
}

export const THEMES: readonly Theme[] = [
  {
    name: 'xo-dark',
    description: 'Default dark theme',
    primary: '#7aa2f7',
    accent: '#bb9af7',
    success: '#9ece6a',
    warning: '#e0af68',
    error: '#f7768e',
    muted: '#7f849c',
    border: '#565f89',
    borderActive: '#7aa2f7',
    shell: '#e0af68',
    gradient: ['#4796e4', '#847ace', '#c3677f'],
  },
  {
    name: 'xo-light',
    description: 'Light-background theme',
    primary: '#2a5db0',
    accent: '#7a3fb0',
    success: '#2e7d32',
    warning: '#9a6700',
    error: '#c62828',
    muted: '#6b7280',
    border: '#9ca3af',
    borderActive: '#2a5db0',
    shell: '#9a6700',
    gradient: ['#2a5db0', '#6b46c1', '#b83280'],
  },
  {
    name: 'dracula',
    description: 'Dracula palette',
    primary: '#bd93f9',
    accent: '#ff79c6',
    success: '#50fa7b',
    warning: '#f1fa8c',
    error: '#ff5555',
    muted: '#6272a4',
    border: '#44475a',
    borderActive: '#bd93f9',
    shell: '#ffb86c',
    gradient: ['#bd93f9', '#ff79c6', '#ffb86c'],
  },
  {
    name: 'github-dark',
    description: 'GitHub dark palette',
    primary: '#58a6ff',
    accent: '#d2a8ff',
    success: '#3fb950',
    warning: '#d29922',
    error: '#f85149',
    muted: '#8b949e',
    border: '#30363d',
    borderActive: '#58a6ff',
    shell: '#d29922',
    gradient: ['#58a6ff', '#d2a8ff', '#ff7b72'],
  },
  {
    name: 'ansi',
    description: "Uses your terminal's own 16-color palette",
    primary: 'blue',
    accent: 'magenta',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    muted: 'gray',
    border: 'gray',
    borderActive: 'blue',
    shell: 'yellow',
    gradient: ['blue', 'magenta', 'red'],
  },
];

export const DEFAULT_THEME = THEMES[0]!;

export function findTheme(name: string): Theme | undefined {
  return THEMES.find((t) => t.name === name);
}

/** Bundles a theme with a painter so call sites can write `ui.success('done')`. */
export interface Ui {
  readonly theme: Theme;
  readonly painter: Painter;
  primary(text: string): string;
  accent(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  muted(text: string): string;
  border(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

export function createUi(theme: Theme, painter: Painter): Ui {
  return {
    theme,
    painter,
    primary: (t) => painter.fg(theme.primary, t),
    accent: (t) => painter.fg(theme.accent, t),
    success: (t) => painter.fg(theme.success, t),
    warning: (t) => painter.fg(theme.warning, t),
    error: (t) => painter.fg(theme.error, t),
    muted: (t) => painter.fg(theme.muted, t),
    border: (t) => painter.fg(theme.border, t),
    bold: (t) => painter.bold(t),
    dim: (t) => painter.dim(t),
  };
}
