import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { ChooseWorkspace } from '../../src/ui/ChooseWorkspace';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

const two = [
  { workspaceId: 'ws_1', name: 'Claims Ops', createdAt: '2026-10-01T09:00:00Z' },
  { workspaceId: 'ws_2', createdAt: '2026-10-05T09:00:00Z' },
];

describe('Choose a workspace screen', () => {
  it('lists the real workspaces, selects the first, and shows only what the platform provided', () => {
    render(<ChooseWorkspace workspaces={two} onOpen={vi.fn()} onCreate={vi.fn()} onSwitchAccount={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Choose a workspace' })).toBeInTheDocument();
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
    expect(options[1]).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Untitled workspace')).toBeInTheDocument();
    expect(screen.queryByText(/members|offline|private server/i)).not.toBeInTheDocument();
  });

  it('opens the selected workspace, and Create / Switch account call their handlers', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onCreate = vi.fn();
    const onSwitchAccount = vi.fn();
    render(<ChooseWorkspace workspaces={two} onOpen={onOpen} onCreate={onCreate} onSwitchAccount={onSwitchAccount} />);
    await user.click(screen.getAllByRole('radio')[1]!);
    await user.click(screen.getByRole('button', { name: 'Open workspace' }));
    expect(onOpen).toHaveBeenCalledWith('ws_2');
    await user.click(screen.getByRole('button', { name: '+ Create workspace' }));
    expect(onCreate).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Switch account' }));
    expect(onSwitchAccount).toHaveBeenCalled();
  });

  it('is shown on arrival when there are several workspaces, and opens the one chosen', async () => {
    const api = new FakeXo();
    api.workspaces.push(
      { workspaceId: 'ws_a', name: 'Claims Ops', createdAt: '2026-10-01T09:00:00Z' },
      { workspaceId: 'ws_b', name: 'Renewals', createdAt: '2026-10-02T09:00:00Z' },
    );
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByRole('heading', { name: 'Choose a workspace' });
    await user.click(screen.getByRole('radio', { name: /Renewals/ }));
    await user.click(screen.getByRole('button', { name: 'Open workspace' }));
    expect(await screen.findByRole('heading', { name: 'Renewals' })).toBeInTheDocument();
  });

  it('does not interrupt a person who has exactly one workspace', async () => {
    const api = new FakeXo();
    api.workspaces.push({ workspaceId: 'ws_a', name: 'Claims Ops', createdAt: '2026-10-01T09:00:00Z' });
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByRole('heading', { name: 'Claims Ops' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Choose a workspace' })).not.toBeInTheDocument();
  });
});
