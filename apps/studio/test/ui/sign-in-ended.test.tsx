import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ApiProblem } from '../../src/platform/client';
import { ProblemNotice } from '../../src/ui/primitives';
import { SessionProvider } from '../../src/ui/session';

const ended: ApiProblem = { kind: 'unauthenticated', status: 401, message: 'unauthenticated' };

function shown(onReauthenticate?: () => Promise<string | undefined>) {
  return render(
    <SessionProvider apiKey="k" onSignOut={() => undefined} {...(onReauthenticate !== undefined ? { onReauthenticate } : {})}>
      <label>
        Draft
        <input defaultValue="kept" />
      </label>
      <ProblemNotice problem={ended} />
    </SessionProvider>,
  );
}

describe('S1-11 a sign-in that ends part-way through', () => {
  it('offers "Sign in again" in place where the app can, and keeps the screen', async () => {
    const reauth = vi.fn(async () => undefined);
    shown(reauth);
    expect(screen.getByText('Your sign-in has ended')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(reauth).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Draft')).toHaveValue('kept');
  });

  it('with an access key, says the key was not accepted and offers no sign-in button', () => {
    shown();
    expect(screen.getByText('Your access key was not accepted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });
});
