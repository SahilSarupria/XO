import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, workspaceReady } from './nav';

/**
 * S1-12 copy test. In User mode the words on every place (headings, buttons, tabs, field labels and the sentences between them) use
 * the glossary and no industry word. Builder mode may name technical things; this test is about what a customer reads.
 * What a customer's own documents say is theirs and is not read here (it sits in quotations marked `evidence`).
 */
const TECHNICAL =
  /\b(certificate|xoir|compilation|candidate workflow|capabilit(?:y|ies)|artifact|sha-?256|digest|bundle|idempoten\w*|webhook secret)\b/i;
const INDUSTRY = /\b(insur\w*|underwrit\w*|patient\w*|claimant\w*|premium\w*|loan\w*|mortgage\w*|adjuster\w*|policyholder\w*)\b/i;

function visibleWords(): string[] {
  const nodes = Array.from(
    document.body.querySelectorAll<HTMLElement>(
      'h1,h2,h3,h4,button,[role="tab"],label,legend,summary,p,li,th,[role="status"],[role="alert"]',
    ),
  ).filter((el) => el.closest('.evidence, [data-user-content]') === null && el.closest('[aria-hidden="true"]') === null);
  return nodes.map((el) => el.textContent?.trim() ?? '').filter((t) => t.length > 0);
}

async function open(): Promise<ReturnType<typeof userEvent.setup>> {
  const api = new FakeXo();
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
  return user;
}

const PLACES = ['Home', 'Inbox', 'Work', 'Sources', 'Knowledge', 'Activity', 'Settings'] as const;

describe('copy: what a customer reads', () => {
  it('uses no technical or industry word on any place', async () => {
    const user = await open();
    const found: string[] = [];
    for (const place of PLACES) {
      await openScreen(user, place);
      await screen.findAllByRole('heading');
      for (const t of visibleWords()) {
        if (TECHNICAL.test(t) || INDUSTRY.test(t)) found.push(`${place}: ${t.slice(0, 120)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('every Settings section too', async () => {
    const user = await open();
    await openScreen(user, 'Settings');
    const found: string[] = [];
    for (const tab of screen.getAllByRole('tab', {
      name: /^(General|Members|Models and runtime|Data and residency|Trust and signing|Notifications|Standing approvals|Operations)$/,
    })) {
      await user.click(tab);
      for (const t of visibleWords()) {
        if (TECHNICAL.test(t) || INDUSTRY.test(t)) found.push(`${tab.textContent}: ${t.slice(0, 120)}`);
      }
    }
    expect(found).toEqual([]);
  });
});
