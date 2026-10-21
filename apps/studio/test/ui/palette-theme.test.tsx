import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { isPaletteShortcut, matchCommands } from '../../src/ui/CommandPalette';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

async function signedIn(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}

describe('command palette helpers', () => {
  it('recognises ⌘K and Ctrl+K only', () => {
    expect(isPaletteShortcut({ key: 'k', metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPaletteShortcut({ key: 'K', metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: 'k', metaKey: false, ctrlKey: false })).toBe(false);
    expect(isPaletteShortcut({ key: 'j', metaKey: true, ctrlKey: false })).toBe(false);
  });
  it('filters by label, ignoring case and spaces at the ends', () => {
    const cmds = [{ id: 'a', label: 'Go to Library', run: () => {} }, { id: 'b', label: 'Open Chat', run: () => {} }];
    expect(matchCommands(cmds, ' LIB ').map((c) => c.id)).toEqual(['a']);
    expect(matchCommands(cmds, '').length).toBe(2);
    expect(matchCommands(cmds, 'zzz')).toEqual([]);
  });
});

describe('command palette in the app', () => {
  it('opens on Ctrl+K, filters, goes to a screen with Enter, and Escape closes it', async () => {
    const user = await signedIn(new FakeXo());
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    await user.keyboard('{Control>}k{/Control}');
    const box = await screen.findByRole('combobox', { name: 'Type a command' });
    expect(box).toHaveFocus();
    await user.type(box, 'library{Enter}');
    expect(window.location.hash).toBe('#/library');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'nonsense');
    expect(screen.getByText(/No command matches/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });
});

describe('light theme', () => {
  it('switches from Settings and from the palette, and the document follows', async () => {
    const user = await signedIn(new FakeXo());
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'light{Enter}');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'settings{Enter}');
    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});

describe('fonts and theme tokens are bundled', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8');
  it('loads Instrument Sans and JetBrains Mono from npm packages, never from a CDN', () => {
    const main = read('src/main.tsx');
    expect(main).toContain("@fontsource-variable/instrument-sans");
    expect(main).toContain("@fontsource-variable/jetbrains-mono");
    for (const f of ['index.html', 'src/styles/tokens.css', 'src/styles/app.css'])
      expect(read(f)).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\./i);
    expect(read('src/styles/tokens.css')).toMatch(/--font-sans: 'Instrument Sans Variable'/);
    expect(read('src/styles/tokens.css')).toMatch(/--font-mono: 'JetBrains Mono Variable'/);
  });
  it('defines every colour token in the light theme that the dark theme defines', () => {
    const css = read('src/styles/tokens.css');
    const names = (block: string) => new Set([...block.matchAll(/(--(?:bg|surface|border|text(?!-(?:xs|sm|md|lg|xl|2xl))|accent|success|warning|danger|info)[a-z0-9-]*):/g)].map((m) => m[1]));
    const dark = names(css.slice(0, css.indexOf(":root[data-theme='light']")));
    const light = names(css.slice(css.indexOf(":root[data-theme='light']")));
    for (const n of dark) expect(light, n).toContain(n);
  });
});
