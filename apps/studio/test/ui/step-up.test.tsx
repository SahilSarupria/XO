import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProblemNotice } from '../../src/ui/primitives';
import { SessionProvider } from '../../src/ui/session';
import type { ApiProblem } from '../../src/platform/client';

const stepUp: ApiProblem = {
  kind: 'unauthenticated',
  status: 401,
  code: 'XO_AUTH_STEP_UP_REQUIRED',
  message: 'a recent sign-in is required',
};

function shown(onReauthenticate?: () => Promise<string | undefined>) {
  return render(
    <SessionProvider apiKey="k" onSignOut={() => undefined} {...(onReauthenticate !== undefined ? { onReauthenticate } : {})}>
      <label>
        Reason
        <input defaultValue="typed before" />
      </label>
      <ProblemNotice problem={stepUp} />
    </SessionProvider>,
  );
}

describe('S1-6 a recent sign-in is asked for in place', () => {
  it('signs in again without leaving the screen, and says nothing was done yet', async () => {
    const reauth = vi.fn(async () => undefined);
    shown(reauth);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(reauth).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('You are signed in again. Nothing was done yet: repeat the action.')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toHaveValue('typed before');
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  it('says why when signing in again did not work, and offers it again', async () => {
    shown(async () => 'The sign-in window was closed.');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByText('The sign-in window was closed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
  });

  it('offers no button where this app has no interactive sign-in (an access key), and still says what to do', () => {
    shown();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(screen.getByText('Sign out, sign in again, and repeat the action.')).toBeInTheDocument();
  });
});
