import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { isPaletteShortcut, matchCommands } from '../../src/ui/CommandPalette';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { sectionOf } from '../../src/ui/sectionRoute';
import { workspaceReady } from './nav';

async function signedIn(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
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
    const cmds = [
      { id: 'a', label: 'Go to Library', run: () => {} },
      { id: 'b', label: 'Open Chat', run: () => {} },
    ];
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
    expect(sectionOf(window.location)).toBe('library');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'nonsense');
    expect(screen.getByText(/No command matches/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });
});

describe('themes', () => {
  it('is dark by default, switches from Settings and from the palette, and the document follows', async () => {
    const user = await signedIn(new FakeXo());
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'light{Enter}');
    expect(document.documentElement.dataset['theme']).toBe('light');
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'settings{Enter}');
    expect(screen.getByRole('radio', { name: 'Light theme' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Dark theme (default)' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(window.localStorage.getItem('xo.studio.theme')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Match this device' }));
    expect(screen.getByRole('radio', { name: 'Match this device' })).toBeChecked();
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});

describe('fonts and theme tokens are bundled', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8');
  it('loads Instrument Sans and JetBrains Mono from npm packages, never from a CDN', () => {
    const main = read('src/main.tsx');
    expect(main).toContain('@fontsource-variable/instrument-sans');
    expect(main).toContain('@fontsource-variable/jetbrains-mono');
    for (const f of ['index.html', 'src/styles/tokens.css', 'src/styles/app.css'])
      expect(read(f)).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\./i);
    expect(read('src/styles/tokens.css')).toMatch(/--font-sans:\s+'Instrument Sans Variable'/);
    expect(read('src/styles/tokens.css')).toMatch(/--font-mono:\s+'JetBrains Mono Variable'/);
  });
  it('defines every colour token in the dark base theme that the light theme overrides', () => {
    const css = read('src/styles/tokens.css');
    const names = (block: string) => new Set([...block.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
    const start = css.indexOf(":root[data-theme='light']");
    const light = names(css.slice(start, css.indexOf('\n}', start)));
    const dark = names(css.slice(0, start));
    expect(light.size).toBeGreaterThan(10);
    for (const n of light) expect(dark, n).toContain(n);
  });
});
