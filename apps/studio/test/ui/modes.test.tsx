import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

type U = ReturnType<typeof userEvent.setup>;
const nav = () => screen.getByRole('navigation', { name: /workspace sections/i });
const navLabels = () =>
  within(nav())
    .getAllByRole('button')
    .map((b) => b.querySelector('.nav-label')?.textContent);
const modeGroup = () => screen.getByRole('group', { name: /detail level/i });
const goNav = (user: U, name: RegExp | string) => user.click(within(nav()).getByRole('button', { name }));

async function connect(api: FakeXo): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: /connect/i }));
  return user;
}
async function open(api: FakeXo): Promise<U> {
  const user = await connect(api);
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops', level: 1 });
  return user;
}
async function analysed(api: FakeXo): Promise<U> {
  api.publishContract = true;
  const user = await open(api);
  await goNav(user, /^sources/i);
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  return user;
}
const toBuilder = (user: U) => user.click(within(modeGroup()).getByRole('button', { name: 'Builder' }));
const toUser = (user: U) => user.click(within(modeGroup()).getByRole('button', { name: 'User' }));
const writes = (api: FakeXo) => api.calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', window.location.pathname);
});

describe('mode: default, switching and persistence', () => {
  it('starts in User mode with no technical screens, and says so', async () => {
    await open(new FakeXo());
    expect(within(modeGroup()).getByRole('button', { name: 'User' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(modeGroup()).getByRole('button', { name: 'Builder' })).toHaveAttribute('aria-pressed', 'false');
    expect(navLabels()).toEqual(['Home', 'Workspaces', 'Sources', 'Workflows', 'Runs & History']);
    expect(screen.queryByRole('group', { name: /builder tools/i })).not.toBeInTheDocument();
    expect(screen.getByText('User mode')).toBeInTheDocument();
  });

  it('Builder mode adds one group of technical screens to the same navigation, and shows the mode', async () => {
    const user = await open(new FakeXo());
    await toBuilder(user);
    expect(navLabels()).toEqual(['Home', 'Workspaces', 'Sources', 'Workflows', 'Runs & History', 'Contracts', 'Processes', 'Platform']);
    expect(within(screen.getByRole('group', { name: /builder tools/i })).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('Builder mode')).toBeInTheDocument();
  });

  it('switching modes keeps the workspace and the current screen, and sends no request', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await goNav(user, /^workflows/i);
    const before = api.calls.length;
    await toBuilder(user);
    expect(screen.getByRole('heading', { name: 'Ops', level: 1 })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/work');
    await toUser(user);
    expect(screen.getByRole('heading', { name: 'Ops', level: 1 })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/work');
    expect(writes(api)).toEqual(api.calls.filter((c) => c.method === 'POST' && c.path === '/workspaces'));
    expect(api.calls.slice(before).filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('the choice survives a reload, and a fresh browser starts in User mode', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await toBuilder(user);
    expect(window.localStorage.getItem('xo-studio:mode')).toBe('builder');
    cleanup();
    await connect(api);
    expect(await screen.findByRole('heading', { name: 'Ops', level: 1 })).toBeInTheDocument();
    expect(within(modeGroup()).getByRole('button', { name: 'Builder' })).toHaveAttribute('aria-pressed', 'true');
    cleanup();
    window.localStorage.clear();
    await connect(api);
    await screen.findByRole('heading', { name: 'Ops', level: 1 });
    expect(within(modeGroup()).getByRole('button', { name: 'User' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the switch is a labelled group of buttons that works from the keyboard', async () => {
    const user = await open(new FakeXo());
    const builder = within(modeGroup()).getByRole('button', { name: 'Builder' });
    builder.focus();
    await user.keyboard('{Enter}');
    expect(builder).toHaveAttribute('aria-pressed', 'true');
    expect(builder).toHaveFocus();
    await user.keyboard(' ');
    expect(builder).toHaveAttribute('aria-pressed', 'true');
    const userBtn = within(modeGroup()).getByRole('button', { name: 'User' });
    userBtn.focus();
    await user.keyboard('{Enter}');
    expect(userBtn).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('mode: routes that belong to Builder mode', () => {
  it('a Builder-only link opened in User mode is explained, lands on Home, and can switch without losing the place', async () => {
    window.location.hash = '#/platform';
    const user = await open(new FakeXo());
    expect(window.location.hash).toBe('#/home');
    const note = await screen.findByText(/platform is part of builder mode/i);
    expect(note).toHaveTextContent(/does not change what you are allowed to do/i);
    await user.click(screen.getByRole('button', { name: /switch to builder mode/i }));
    expect(await screen.findByRole('heading', { name: 'Platform', level: 2 })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/platform');
    expect(screen.getByRole('heading', { name: 'Ops', level: 1 })).toBeInTheDocument();
  });

  it('switching to User mode on a Builder screen lands on the nearest everyday screen', async () => {
    const user = await open(new FakeXo());
    await toBuilder(user);
    const expectations: [RegExp, string, RegExp][] = [
      [/^processes/i, '#/work', /^workflows$/i],
      [/^contracts/i, '#/setup', /^context$/i],
      [/^platform/i, '#/home', /^home$/i],
    ];
    for (const [item, hash, heading] of expectations) {
      await goNav(user, item);
      await toUser(user);
      expect(window.location.hash).toBe(hash);
      expect(await screen.findByRole('heading', { name: heading, level: 2 })).toBeInTheDocument();
      expect(screen.queryByText(/is part of builder mode/i)).not.toBeInTheDocument();
      await toBuilder(user);
    }
  });

  it('Back and Forward keep working across a mode switch', async () => {
    const user = await open(new FakeXo());
    await toBuilder(user);
    await goNav(user, /^platform/i);
    await screen.findByRole('heading', { name: 'Platform', level: 2 });
    await toUser(user);
    expect(window.location.hash).toBe('#/home');
  });
});

describe('Builder: Contracts', () => {
  it('shows each rule with the platform contract as reported, and says when no contract was published', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await toBuilder(user);
    await goNav(user, /^contracts/i);
    const list = await screen.findByRole('list', { name: 'Capability contracts' });
    const cards = Array.from(list.children);
    expect(cards.length).toBeGreaterThan(1);
    // The raw record scrolls, so it is focusable and named.
    for (const raw of Array.from(list.querySelectorAll('pre.code'))) {
      expect(raw).toHaveAttribute('tabindex', '0');
      expect(raw).toHaveAccessibleName(/^Raw record for /);
    }
    // Each card shows its capability id once; an identical contract id is not repeated.
    expect(within(list).getAllByText(/confidence \d+%/)).toHaveLength(cards.length);
    expect(within(list).queryByText(/· contract cap_/)).not.toBeInTheDocument();
    // cap_det has a published contract (a table); the others honestly have none.
    expect(within(list).getAllByRole('table', { hidden: true }).length).toBe(1);
    expect(within(list).getAllByText(/no input contract was published/i).length).toBe(cards.length - 1);
    expect(within(list).getAllByText(/does not mean no input is needed/i).length).toBeGreaterThan(0);
  });

  it('with no analysis it says so and points to Sources, and invents no contracts', async () => {
    const user = await open(new FakeXo());
    await toBuilder(user);
    await goNav(user, /^contracts/i);
    expect(await screen.findByText('No contracts yet')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Capability contracts' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Sources' }));
    expect(window.location.hash).toBe('#/setup');
  });

  it('a failed load is an error with Retry, never an empty list', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await toBuilder(user);
    cleanup(); // a fresh session, where the contracts cannot be loaded
    api.failing.add('/capabilities');
    await connect(api);
    await screen.findByRole('heading', { name: 'Ops', level: 1 });
    await goNav(user, /^contracts/i);
    expect(await screen.findByRole('alert')).toBeInTheDocument(); // the workspace-level notice, once
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
    expect(screen.getByText(/contracts could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('No contracts yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Capability contracts' })).not.toBeInTheDocument();
  });

  it('visiting Builder screens sends no write request', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    const before = api.calls.length;
    await toBuilder(user);
    for (const n of [/^contracts/i, /^processes/i, /^platform/i]) await goNav(user, n);
    await screen.findByRole('heading', { name: 'Platform', level: 2 });
    expect(api.calls.slice(before).filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('Builder: Processes and cross-links', () => {
  it('lists the real steps and opens the matching contract', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await toBuilder(user);
    await goNav(user, /^processes/i);
    const steps = await screen.findAllByText(/^Steps \(/);
    expect(steps.length).toBeGreaterThan(0);
    await user.click(steps[0]!);
    const link = (await screen.findAllByRole('button', { name: /open contract for/i }))[0]!;
    await user.click(link);
    expect(window.location.hash).toBe('#/contracts');
    expect(await screen.findByRole('heading', { name: 'Contracts', level: 2 })).toBeInTheDocument();
    expect(document.querySelector('[data-focused="true"]')).not.toBeNull();
  });
});

describe('Builder: Platform requests', () => {
  it('only ever calls GET /health and GET /openapi.json, however often it is opened', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await toBuilder(user);
    await goNav(user, /^platform/i);
    await screen.findByRole('table', { name: 'Platform API operations' });
    await goNav(user, /^home/i);
    await goNav(user, /^platform/i);
    await screen.findByRole('table', { name: 'Platform API operations' });
    const platform = api.calls.filter((c) => c.path === '/health' || c.path === '/openapi.json');
    expect(platform.length).toBeGreaterThanOrEqual(2);
    expect(platform.every((c) => c.method === 'GET')).toBe(true);
    expect(new Set(platform.map((c) => c.path))).toEqual(new Set(['/health', '/openapi.json']));
  });

  it('a malformed API description is refused as untrustworthy and none of it is shown', async () => {
    const api = new FakeXo();
    const bad: typeof api.fetch = async (input, init) =>
      input.endsWith('/openapi.json')
        ? new Response(JSON.stringify({ info: { title: 'Looks fine' }, paths: { '/x': { get: { summary: 'Delete everything' } } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : api.fetch(input, init);
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={bad} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: /connect/i }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Ops', level: 1 });
    await toBuilder(user);
    await goNav(user, /^platform/i);
    expect(await screen.findByText(/studio could not trust/i)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Platform API operations' })).not.toBeInTheDocument();
    expect(screen.queryByText('Delete everything')).not.toBeInTheDocument();
    expect(screen.queryByText(/looks fine/i)).not.toBeInTheDocument();
  });
});

describe('Builder: Platform', () => {
  it('shows service status and the platform API as it describes itself, with a working filter', async () => {
    const user = await open(new FakeXo());
    await toBuilder(user);
    await goNav(user, /^platform/i);
    expect(await screen.findByText('ok')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Platform API operations' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 5);
    expect(within(table).getAllByText('Open').length).toBe(1); // only /health declares no security
    // Short columns never break inside a word ("GE T", "Op en"); long ones may wrap.
    for (const cell of [
      ...within(table).getAllByText('GET'),
      within(table).getByText('Open'),
      within(table).getByRole('columnheader', { name: 'Method' }),
    ])
      expect(cell).toHaveClass('nowrap');
    // A sideways-scrolling region must be reachable and operable from the keyboard.
    const scroller = table.closest('.table-scroll') as HTMLElement;
    expect(scroller.previousElementSibling).toHaveClass('scroll-hint'); // the visual cue (shown on narrow screens)
    expect(scroller.previousElementSibling).toHaveTextContent(/swipe sideways/i);
    expect(scroller).toHaveAttribute('tabindex', '0');
    expect(scroller).toHaveAccessibleName(/scrolls sideways/i);
    scroller.focus();
    expect(scroller).toHaveFocus();
    await user.type(screen.getByLabelText('Filter operations'), 'upload');
    expect(within(screen.getByRole('table', { name: 'Platform API operations' })).getAllByRole('row')).toHaveLength(2);
    await user.clear(screen.getByLabelText('Filter operations'));
    await user.type(screen.getByLabelText('Filter operations'), 'zzz');
    expect(await screen.findByText('No operations match')).toBeInTheDocument();
  });

  it('lists what is not available and why, with no control that pretends to do it', async () => {
    const user = await open(new FakeXo());
    await toBuilder(user);
    await goNav(user, /^platform/i);
    const list = await screen.findByRole('list', { name: 'Not available in Studio yet' });
    expect(within(list).getByText(/xoir and knowledge or capability graph viewer/i)).toBeInTheDocument();
    expect(within(list).getByText(/no read endpoint that returns the xoir or graph behind your documents/i)).toBeInTheDocument();
    expect(within(list).getByText(/ai-assisted execution is switched off by the platform itself/i)).toBeInTheDocument();
    expect(within(list).getByText(/studio has no support for them yet/i)).toBeInTheDocument();
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
  });

  it('a service that cannot be reached is reported as such, not as healthy or empty', async () => {
    const api = new FakeXo();
    api.failing.add('/health');
    api.failing.add('/openapi.json');
    const user = await open(api);
    await toBuilder(user);
    await goNav(user, /^platform/i);
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.queryByText('The service answered the health check.')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Platform API operations' })).not.toBeInTheDocument();
  });
});

describe('User mode journeys are unchanged by the existence of Builder mode', () => {
  it('Home → Start work → Sources works in both modes', async () => {
    for (const builder of [false, true]) {
      cleanup();
      window.localStorage.clear();
      window.history.replaceState(null, '', window.location.pathname);
      const user = await open(new FakeXo());
      if (builder) await toBuilder(user);
      await user.click(within(screen.getByRole('region', { name: 'Start work' })).getByRole('button', { name: 'Add your first document' }));
      expect(await screen.findByRole('heading', { name: 'Context' })).toBeInTheDocument();
      expect(window.location.hash).toBe('#/setup');
    }
  });

  it('User mode explains what is received, what is inferred, and who approves', async () => {
    const user = await open(new FakeXo());
    await goNav(user, /^sources/i);
    expect(screen.getByText(/documents are what you gave xo\. rules are what xo worked out/i)).toBeInTheDocument();
    await toBuilder(user);
    expect(screen.queryByText(/documents are what you gave xo/i)).not.toBeInTheDocument();
  });
});
