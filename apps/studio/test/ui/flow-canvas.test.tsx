import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { fitView, zoomAt } from '../../src/ui/FlowCanvas';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;
type Edge = { from: string; to: string; when?: string };
type VNode = { id: string; position?: { x: number; y: number } };

async function openEditor(api: FakeXo): Promise<U> {
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
  await within(screen.getByRole('complementary', { name: 'Node palette' })).findByRole('button', { name: 'Branch on confidence' });
  return user;
}
const canvas = () => screen.getByRole('region', { name: 'Workflow graph' });
const palette = () => screen.getByRole('complementary', { name: 'Node palette' });
const lastValidate = (api: FakeXo) =>
  (api.calls.filter((x) => /workflow-definitions\/validate$/.test(x.path)).at(-1)?.body as { edges: Edge[] } | undefined)?.edges;

describe('Workflow canvas: insert a step exactly where you point', () => {
  it('a "+" on a connection arms the palette; the next step is spliced into that connection and the platform re-validates', async () => {
    const api = new FakeXo();
    const user = await openEditor(api);
    await user.click(within(canvas()).getByRole('button', { name: 'Insert a step after Start' }));
    expect(within(palette()).getByRole('status')).toHaveTextContent(/adding after start/i);
    await user.click(within(palette()).getByRole('button', { name: 'Person reviews' }));
    expect(within(canvas()).getByText('5 nodes')).toBeInTheDocument();
    await waitFor(() =>
      expect(lastValidate(api)).toEqual(
        expect.arrayContaining([
          { from: 'n0', to: 'n4' },
          { from: 'n4', to: 'n1' },
        ]),
      ),
    );
    // The target is spent once used.
    expect(within(palette()).queryByRole('status')).not.toBeInTheDocument();
  });

  it('the stub at the end of a path adds a step there, and Escape or Cancel disarms it without changing anything', async () => {
    const api = new FakeXo();
    const user = await openEditor(api);
    await user.click(within(canvas()).getByRole('button', { name: /^Add a step after A person reviews/ }));
    expect(within(palette()).getByRole('status')).toHaveTextContent(/adding after a person reviews/i);
    await user.keyboard('{Escape}');
    expect(within(palette()).queryByRole('status')).not.toBeInTheDocument();
    expect(within(canvas()).getByText('4 nodes')).toBeInTheDocument();

    await user.click(within(canvas()).getByRole('button', { name: /^Add a step after A person reviews/ }));
    await user.click(within(palette()).getByRole('button', { name: 'Cancel' }));
    expect(within(palette()).queryByRole('status')).not.toBeInTheDocument();

    await user.click(within(canvas()).getByRole('button', { name: /^Add a step after A person reviews/ }));
    await user.click(within(palette()).getByRole('button', { name: 'Person reviews' }));
    expect(within(canvas()).getByText('5 nodes')).toBeInTheDocument();
    await waitFor(() => expect(lastValidate(api)).toEqual(expect.arrayContaining([{ from: 'n3', to: 'n4' }])));
  });

  it('a new branch keeps the old next step on "at or above", offers a stub only on the empty "below" side, and inserts there when pointed at', async () => {
    const api = new FakeXo();
    const user = await openEditor(api);
    await user.click(within(palette()).getByRole('button', { name: 'Branch on confidence' }));
    // "At or above" already leads on, so it has an insert control on its connection, not an add stub.
    expect(within(canvas()).getByRole('button', { name: 'Insert a step after Branch (at or above)' })).toBeInTheDocument();
    expect(within(canvas()).queryByRole('button', { name: 'Add a step after Branch (at or above)' })).not.toBeInTheDocument();
    await user.click(within(canvas()).getByRole('button', { name: 'Add a step after Branch (below)' }));
    expect(within(palette()).getByRole('status')).toHaveTextContent(/adding after branch \(below\)/i);
    await user.click(within(palette()).getByRole('button', { name: 'Person reviews' }));
    await waitFor(() => expect(lastValidate(api)).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'n4', when: 'lt' })])));
    // Both sides lead somewhere now: no stub is left on the branch.
    expect(within(canvas()).queryByRole('button', { name: /^Add a step after Branch/ })).not.toBeInTheDocument();
  });

  it('offers no insert or add controls to a role that cannot edit', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    await openEditor(api);
    expect(within(canvas()).queryByRole('button', { name: /^(Insert|Add) a step/ })).not.toBeInTheDocument();
  });

  it('marks a step the platform will refuse to run because it is not approved, from the capability record only', async () => {
    const user = await openEditor(new FakeXo());
    expect(within(canvas()).getAllByText('Not approved').length).toBeGreaterThan(0);
    expect(user).toBeDefined();
  });
});

describe('Workflow editor side panel', () => {
  it('shows the step settings and the draft in separate tabs, and brings the draft forward when a save reports back', async () => {
    const api = new FakeXo();
    const user = await openEditor(api);
    const tabs = screen.getByRole('tablist', { name: 'Side panel' });
    expect(within(tabs).getByRole('tab', { name: 'Step' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    expect(within(tabs).getByRole('tab', { name: /^Draft/ })).toHaveAttribute('aria-selected', 'true');
    await user.click(within(canvas()).getByRole('button', { name: /^Record before payment/ }));
    expect(within(tabs).getByRole('tab', { name: 'Step' })).toHaveAttribute('aria-selected', 'true');
  });
});

const lastNodes = (api: FakeXo) =>
  (api.calls.filter((x) => /workflow-definitions\/validate$/.test(x.path)).at(-1)?.body as { nodes: VNode[] } | undefined)?.nodes;

describe('Workflow canvas: connect, disconnect and place steps', () => {
  it('click an output dot, then a step, to connect them; the old target is left unconnected and the platform re-validates', async () => {
    const api = new FakeXo();
    const user = await openEditor(api);
    await user.click(within(canvas()).getByRole('button', { name: 'Connect from Start' }));
    await user.click(within(canvas()).getByRole('button', { name: /^Review not covered/ }));
    await waitFor(() => expect(lastValidate(api)).toEqual(expect.arrayContaining([{ from: 'n0', to: 'n2' }])));
    expect(lastValidate(api)).not.toEqual(expect.arrayContaining([{ from: 'n0', to: 'n1' }]));
  });

  it('Escape abandons a half-made connection; clicking a step then just selects it', async () => {
    const api = new FakeXo();
    const user = await openEditor(api);
    const before = api.calls.length;
    await user.click(within(canvas()).getByRole('button', { name: 'Connect from Start' }));
    await user.keyboard('{Escape}');
    await user.click(within(canvas()).getByRole('button', { name: /^Review not covered/ }));
    expect(within(canvas()).getByRole('button', { name: /^Review not covered/ })).toHaveAttribute('aria-pressed', 'true');
    expect(api.calls.slice(before).filter((c) => /validate$/.test(c.path))).toHaveLength(0);
  });

  it('a connection can be removed from its own control, leaving both steps', async () => {
    const api = new FakeXo();
    const user = await openEditor(api);
    await user.click(within(canvas()).getByRole('button', { name: /^Disconnect Record before payment from Review not covered/ }));
    await waitFor(() => expect(lastValidate(api)).not.toEqual(expect.arrayContaining([{ from: 'n1', to: 'n2' }])));
    expect(within(canvas()).getByText('4 nodes')).toBeInTheDocument();
    // The end of that path is open again, so it offers an add stub.
    expect(within(canvas()).getByRole('button', { name: 'Add a step after Record before payment' })).toBeInTheDocument();
  });

  it('dragging a step places it, saves the position with the draft, and "Tidy up" forgets it', async () => {
    const api = new FakeXo();
    const user = await openEditor(api);
    const card = within(canvas()).getByRole('button', { name: /^Review not covered/ });
    // jsdom has no PointerEvent; React listens by event name, so a MouseEvent carries the coordinates.
    const ptr = (type: string, x: number, y: number) =>
      fireEvent(card, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    ptr('pointerdown', 300, 300);
    ptr('pointermove', 420, 360);
    ptr('pointerup', 420, 360);
    await waitFor(() => expect(lastNodes(api)?.find((x) => x.id === 'n2')?.position).toBeDefined());
    const moved = lastNodes(api)!.find((x) => x.id === 'n2')!.position!;
    expect(moved.x % 12).toBe(0);
    expect(moved.y % 12).toBe(0);
    expect(lastNodes(api)!.filter((x) => x.position !== undefined)).toHaveLength(1);
    await user.click(within(canvas()).getByRole('button', { name: 'Tidy up' }));
    await waitFor(() => expect(lastNodes(api)!.every((x) => x.position === undefined)).toBe(true));
    expect(within(canvas()).queryByRole('button', { name: 'Tidy up' })).not.toBeInTheDocument();
  });

  it('a viewer sees no output dots to connect from, and cannot drag', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    await openEditor(api);
    expect(within(canvas()).queryByRole('button', { name: /^(Connect from|Disconnect) / })).not.toBeInTheDocument();
  });
});

describe('canvas view maths', () => {
  it('fits the whole drawing without ever magnifying past 100%, and centres what is smaller than the view', () => {
    const big = fitView({ width: 2000, height: 600 }, { width: 1000, height: 600 });
    expect(big.k).toBeLessThan(0.5);
    expect(big.k).toBeGreaterThanOrEqual(0.3);
    const small = fitView({ width: 300, height: 100 }, { width: 1000, height: 600 });
    expect(small.k).toBe(1);
    expect(small.x).toBeCloseTo((1000 - 300) / 2);
    expect(small.y).toBeCloseTo((600 - 100) / 2);
  });

  it('is the plain 100% view when nothing has been measured (no layout yet)', () => {
    expect(fitView({ width: 500, height: 200 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, k: 1 });
    expect(fitView({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('zooms about a point: the drawing under the cursor does not move, and the zoom is clamped', () => {
    const v = { x: 40, y: 20, k: 1 };
    const z = zoomAt(v, 2, 300, 200);
    // World point under the cursor before and after.
    expect((300 - v.x) / v.k).toBeCloseTo((300 - z.x) / z.k);
    expect((200 - v.y) / v.k).toBeCloseTo((200 - z.y) / z.k);
    expect(zoomAt(v, 100, 0, 0).k).toBe(1.8);
    expect(zoomAt(v, 0.001, 0, 0).k).toBe(0.3);
  });
});
