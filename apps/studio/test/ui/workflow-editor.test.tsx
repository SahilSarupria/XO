import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;
type Edge = { from: string; to: string; when?: string };
type Node = { id: string; kind: string; label?: string; config: Record<string, unknown> };

async function analysed(api: FakeXo): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await user.click(screen.getByRole('button', { name: /^my xos/i }));
  await user.upload(
    document.getElementById('file-upload') as HTMLInputElement,
    new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
  );
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  await openScreen(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /view graph of/i }));
  await screen.findByRole('region', { name: 'Workflow graph' });
  const palette = screen.getByRole('complementary', { name: 'Node palette' });
  await within(palette).findByRole('button', { name: 'Branch on confidence' }); // the platform has answered what it can run
  return user;
}

const inspector = () => screen.getByRole('complementary', { name: 'Inspector' });
const canvas = () => screen.getByRole('region', { name: 'Workflow graph' });
const node = (name: RegExp | string) => within(canvas()).getByRole('button', { name });
const lastValidate = (api: FakeXo) => {
  const c = api.calls.filter((x) => /workflow-definitions\/validate$/.test(x.path)).at(-1);
  return c?.body as { nodes: Node[]; edges: Edge[] } | undefined;
};

describe('Workflow editor: node operations, validated live by the platform', () => {
  it('removes a step; the chain stays connected and the platform re-validates the new graph', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await user.click(node(/^Record before payment/));
    await user.click(within(inspector()).getByRole('button', { name: 'Remove step' }));
    expect(within(canvas()).getByText('3 nodes')).toBeInTheDocument();
    await waitFor(() => expect(lastValidate(api)?.nodes.map((n) => n.id)).toEqual(['n0', 'n2', 'n3']));
    expect(lastValidate(api)?.edges).toEqual(
      expect.arrayContaining([
        { from: 'n0', to: 'n2' },
        { from: 'n2', to: 'n3' },
      ]),
    );
    expect(lastValidate(api)?.edges).toHaveLength(2);
  });

  it('reorders a step in a straight run, and says why it cannot move when it cannot', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await user.click(node(/^Record before payment/));
    await user.click(within(inspector()).getByRole('button', { name: 'Move later' }));
    await waitFor(() => {
      const edges = lastValidate(api)?.edges ?? [];
      expect(edges).toEqual(
        expect.arrayContaining([
          { from: 'n0', to: 'n2' },
          { from: 'n2', to: 'n1' },
          { from: 'n1', to: 'n3' },
        ]),
      );
    });
    await user.click(node(/^Start/));
    expect(within(inspector()).getByRole('button', { name: 'Move later' })).toBeDisabled();
    expect(within(inspector()).getByText(/stays where it is/)).toBeInTheDocument();
  });

  it('edits a label and a setting; Save sends exactly what the editor holds', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await user.click(node(/^Record before payment/));
    const label = within(inspector()).getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Check the claim');
    expect(node(/^Check the claim/)).toBeInTheDocument();
    const memory = within(inspector()).getByLabelText('Memory scope') as HTMLSelectElement;
    expect([...memory.options].map((o) => [o.value, o.disabled])).toEqual([
      ['none', false],
      ['workflow', true],
      ['workspace', true],
    ]);
    expect(within(inspector()).getByText(/memory scopes are not part of the runtime/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    const saved = api.studio.drafts[0]!.nodes as Node[];
    expect(saved.find((n) => n.id === 'n1')).toMatchObject({
      kind: 'capability',
      label: 'Check the claim',
      config: { memoryScope: 'none', compilationId: expect.any(String) },
    });
    expect(within(canvas()).getByText('Saved')).toBeInTheDocument();
    await user.type(within(inspector()).getByLabelText('Label'), '!');
    expect(within(canvas()).getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('adds a step after the selection from the palette', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await user.click(node(/^Start/));
    await user.click(within(screen.getByRole('complementary', { name: 'Node palette' })).getByRole('button', { name: 'Person reviews' }));
    expect(within(canvas()).getByText('5 nodes')).toBeInTheDocument();
    await waitFor(() =>
      expect(lastValidate(api)?.edges).toEqual(
        expect.arrayContaining([
          { from: 'n0', to: 'n4' },
          { from: 'n4', to: 'n1' },
        ]),
      ),
    );
    expect(within(inspector()).getByRole('heading', { name: 'A person reviews' })).toBeInTheDocument();
  });

  it("shows the platform's own error on the node it names, and clears it when the edit fixes it", async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await user.click(node(/^Record before payment/));
    await user.click(
      within(screen.getByRole('complementary', { name: 'Node palette' })).getByRole('button', { name: 'Branch on confidence' }),
    );
    const branch = await within(canvas()).findByRole('button', { name: /Branch \(Branch\), 1 problem/ });
    expect(branch).toBeInTheDocument();
    expect(await within(inspector()).findByRole('list', { name: 'Problems with this step' })).toHaveTextContent(
      /exactly two outgoing connections/,
    );
    // The fix is the other side of the branch; the platform stops reporting the problem.
    await user.click(within(screen.getByRole('complementary', { name: 'Node palette' })).getByRole('button', { name: 'Person reviews' }));
    await waitFor(() => expect(within(canvas()).queryByRole('button', { name: /problem/ })).not.toBeInTheDocument());
  });

  it("treats a viewer role as a hint only: editing controls are disabled (the platform's own refusal on Save is covered in the drafts tests)", async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    const user = await analysed(api);
    const palette = screen.getByRole('complementary', { name: 'Node palette' });
    expect(within(palette).getByRole('button', { name: 'Branch on confidence' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(node(/^Record before payment/));
    expect(within(inspector()).getByLabelText('Label')).toBeDisabled();
    expect(within(inspector()).getByRole('button', { name: 'Remove step' })).toBeDisabled();
  });
});

describe('Workflow editor: branches (gte / lt) with a threshold, validated by the platform', () => {
  const addBranch = async (user: U) => {
    await user.click(node(/^Record before payment/));
    await user.click(
      within(screen.getByRole('complementary', { name: 'Node palette' })).getByRole('button', { name: 'Branch on confidence' }),
    );
  };

  it('a new branch keeps the old next step on "at or above"; the empty "below" side is the platform\'s error until it leads somewhere', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await addBranch(user);
    await waitFor(() => {
      const g = lastValidate(api)!;
      expect(g.edges).toEqual(
        expect.arrayContaining([
          { from: 'n1', to: 'n4' },
          { from: 'n4', to: 'n2', when: 'gte' },
        ]),
      );
      expect(g.edges.some((e) => e.from === 'n4' && e.when === 'lt')).toBe(false);
      expect(g.nodes.find((n) => n.id === 'n4')?.config).toMatchObject({ metric: 'confidence', threshold: 0.8 });
    });
    expect(await within(inspector()).findByRole('list', { name: 'Problems with this step' })).toHaveTextContent(
      /exactly two outgoing connections/,
    );
    // The next palette add goes to the missing side, and the problem goes away.
    await user.click(within(screen.getByRole('complementary', { name: 'Node palette' })).getByRole('button', { name: 'Person reviews' }));
    await waitFor(() => expect(lastValidate(api)?.edges).toEqual(expect.arrayContaining([{ from: 'n4', to: 'n5', when: 'lt' }])));
    await user.click(node(/^Branch/));
    await waitFor(() => expect(within(inspector()).queryByRole('list', { name: 'Problems with this step' })).not.toBeInTheDocument());
    // With both sides used, the palette says why nothing can be added to the branch itself.
    expect(screen.getByText(/Both sides of this branch already lead somewhere/)).toBeInTheDocument();
    expect(within(canvas()).getByText('at or above')).toBeInTheDocument();
    expect(within(canvas()).getByText('below')).toBeInTheDocument();
  });

  it('edits the threshold, sends it to the platform, and shows the side the platform resolves it to', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await addBranch(user);
    await user.click(within(screen.getByRole('complementary', { name: 'Node palette' })).getByRole('button', { name: 'Person reviews' }));
    await user.click(node(/^Branch/));
    const t = within(inspector()).getByLabelText('Confidence threshold');
    await user.clear(t);
    await user.type(t, '0.95');
    await waitFor(() => expect(lastValidate(api)?.nodes.find((n) => n.id === 'n4')?.config['threshold']).toBe(0.95));
    const status = await within(inspector()).findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/resolves this branch to below/));
    expect(status).toHaveTextContent(/fixed per rule, so it does not change from run to run/);
    await user.clear(t);
    await user.type(t, '0.5');
    await waitFor(() => expect(within(inspector()).getByRole('status')).toHaveTextContent(/resolves this branch to at or above/));
  });

  it('rejects a non-number threshold in the field without changing the draft', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await addBranch(user);
    const t = within(inspector()).getByLabelText('Confidence threshold');
    await user.clear(t);
    await user.type(t, 'high');
    expect(await within(inspector()).findByRole('alert')).toHaveTextContent(/Enter a number/);
    await waitFor(() => expect(lastValidate(api)?.nodes.find((n) => n.id === 'n4')?.config['threshold']).not.toBe('high'));
  });

  it('re-points a side: it can lead to nothing, and then to any free step again', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await addBranch(user);
    await user.click(within(screen.getByRole('complementary', { name: 'Node palette' })).getByRole('button', { name: 'Person reviews' }));
    await user.click(node(/^Branch/));
    const below = within(inspector()).getByLabelText('Below the threshold, go to') as HTMLSelectElement;
    expect(below.value).toBe('n5');
    await user.selectOptions(below, '');
    await waitFor(() => expect(lastValidate(api)?.edges.some((e) => e.from === 'n4' && e.when === 'lt')).toBe(false));
    // the orphaned step is reported by the platform and is now a free target for the branch
    await within(canvas()).findByRole('button', { name: /A person reviews .*1 problem/ });
    const options = [...(within(inspector()).getByLabelText('Below the threshold, go to') as HTMLSelectElement).options].map(
      (o) => o.value,
    );
    expect(options).toContain('n5');
    await user.selectOptions(within(inspector()).getByLabelText('Below the threshold, go to'), 'n5');
    await waitFor(() => expect(lastValidate(api)?.edges).toEqual(expect.arrayContaining([{ from: 'n4', to: 'n5', when: 'lt' }])));
  });

  it('saves a branch with both sides, and the saved copy reloads with the same edges', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await addBranch(user);
    await user.click(within(screen.getByRole('complementary', { name: 'Node palette' })).getByRole('button', { name: 'Person reviews' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    expect((api.studio.drafts[0]!.edges as Edge[]).filter((e) => e.from === 'n4')).toEqual(
      expect.arrayContaining([
        { from: 'n4', to: 'n2', when: 'gte' },
        { from: 'n4', to: 'n5', when: 'lt' },
      ]),
    );
    expect(api.studio.drafts[0]!.nodes.find((n) => (n as Node).id === 'n4')).toMatchObject({
      kind: 'branch',
      config: { metric: 'confidence', threshold: 0.8 },
    });
  });
});
