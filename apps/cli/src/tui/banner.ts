import { gradientColor, visibleLength, wrapAnsi } from './ansi.js';
import type { Ui } from './theme.js';

const LOGO: readonly string[] = [
  '██╗  ██╗ ██████╗ ',
  '╚██╗██╔╝██╔═══██╗',
  ' ╚███╔╝ ██║   ██║',
  ' ██╔██╗ ██║   ██║',
  '██╔╝ ██╗╚██████╔╝',
  '╚═╝  ╚═╝ ╚═════╝ ',
];

/** The startup screen: gradient logo, version line, and the getting-started tips. */
export function renderBanner(ui: Ui, version: string, columns: number): string[] {
  const lines: string[] = [''];
  const logoWidth = Math.max(...LOGO.map((l) => visibleLength(l)));

  if (columns < logoWidth + 4) {
    lines.push(` ${ui.painter.bold(ui.primary('xo'))} ${ui.muted(`v${version}`)}`);
  } else {
    const perChar = ui.painter.level >= 2;
    LOGO.forEach((row, r) => {
      let styled = '';
      if (perChar) {
        let c = 0;
        for (const ch of row) {
          const t = (c / logoWidth) * 0.65 + (r / (LOGO.length - 1)) * 0.35;
          styled += ch === ' ' ? ch : ui.painter.fg(gradientColor(ui.theme.gradient, t), ch);
          c += 1;
        }
      } else {
        styled = ui.painter.fg(gradientColor(ui.theme.gradient, r / (LOGO.length - 1)), row);
      }
      lines.push(` ${styled}`);
    });
    lines.push('', ` ${ui.muted(`Experience Object platform CLI · v${version}`)}`);
  }

  const tip = (n: number, text: string): string[] =>
    wrapAnsi(text, Math.max(20, columns - 6)).map((l, i) => (i === 0 ? ` ${ui.muted(`${n}.`)} ${l}` : `    ${l}`));

  lines.push(
    '',
    ` ${ui.painter.bold('Tips for getting started:')}`,
    ...tip(1, `${ui.accent('/compile')} <file|dir|.zip> turns documents into XOIR. Type ${ui.accent('@')} then Tab to pick a file.`),
    ...tip(2, `${ui.accent('/store')} <dir> points the session at installed packages; plain text then queries them.`),
    ...tip(3, `${ui.accent('/help')} lists every command. ${ui.accent('!')}<cmd> runs a shell command. ${ui.accent('/theme')} changes colors.`),
    '',
  );
  return lines;
}
