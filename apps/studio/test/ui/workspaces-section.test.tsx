import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspacesSection } from '../../src/ui/WorkspacesSection';

describe('WorkspacesSection facts', () => {
  it('shows kind, declared region, member count and the caller role for each workspace', () => {
    render(
      <WorkspacesSection
        activeId="a"
        onSelect={() => {}}
        onNew={() => {}}
        workspaces={[
          {
            workspaceId: 'a',
            name: 'Claims',
            createdAt: '2026-10-01T00:00:00Z',
            kind: 'team',
            region: 'eu',
            regionLabel: 'European Union',
            memberCount: 4,
            role: 'admin',
          },
          { workspaceId: 'b', name: 'Mine', createdAt: '2026-10-02T00:00:00Z', kind: 'personal', memberCount: 1, role: 'viewer' },
          { workspaceId: 'c', createdAt: '2026-10-03T00:00:00Z' },
        ]}
      />,
    );
    const [a, b, c] = within(screen.getByRole('list', { name: 'Your workspaces' })).getAllByRole('listitem');
    expect(within(a!).getByText('Team')).toBeInTheDocument();
    expect(within(a!).getByText('European Union')).toBeInTheDocument();
    expect(within(a!).getByText('4')).toBeInTheDocument();
    expect(within(a!).getByText('Your role:').nextSibling?.textContent).toMatch(/admin/i);
    expect(within(b!).getByText('Personal (one person)')).toBeInTheDocument();
    expect(within(b!).queryByText('Declared region:')).not.toBeInTheDocument();
    // an older server that sends no metadata shows no facts rather than invented ones
    expect(within(c!).queryByText('Type:')).not.toBeInTheDocument();
    expect(within(c!).queryByText('Your role:')).not.toBeInTheDocument();
  });
});
