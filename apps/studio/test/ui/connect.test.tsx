import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import type { OidcConfig } from '../../src/auth/oidc';
import { createWebShellServices } from '../../src/shell/services';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

describe('sign-in screen (design: split layout)', () => {
  it('shows the sign-in heading and the access-key form beside a decorative hero', () => {
    const api = new FakeXo();
    const { container } = render(withShell(<App fetchImpl={api.fetch} />));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText(/access key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    const hero = container.querySelector('.connect-hero');
    expect(hero).not.toBeNull();
    expect(hero?.getAttribute('aria-hidden')).toBe('true'); // decorative: never read out, never focusable content
    expect(hero?.querySelector('button, a, input')).toBeNull();
  });

  it('keeps the privacy promise visible in the form column', () => {
    render(withShell(<App fetchImpl={new FakeXo().fetch} />));
    expect(screen.getByText(/your documents stay yours/i)).toBeInTheDocument();
  });

  it('with Google configured: Google button, an "or" divider, then the development sign-in, in that order', () => {
    const oidc: OidcConfig = { issuer: 'https://idp.test', clientId: 'studio', scopes: ['openid', 'offline_access'] };
    const { container } = render(withShell(<App fetchImpl={new FakeXo().fetch} oidc={oidc} />, createWebShellServices()));
    const google = screen.getByRole('button', { name: 'Continue with Google' });
    const divider = screen.getByRole('separator');
    const dev = screen.getByRole('form', { name: /development sign-in/i });
    expect(divider).toHaveTextContent('or');
    // Browser build cannot run the system-browser sign-in: the button is visibly disabled and says where it works.
    expect(google).toBeDisabled();
    expect(screen.getByText(/available in the xo studio desktop app/i)).toBeInTheDocument();
    const order = [google, divider, dev].map((el) => Array.from(container.querySelectorAll('*')).indexOf(el));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('without Google configured there is no Google button and no divider', () => {
    render(withShell(<App fetchImpl={new FakeXo().fetch} />));
    expect(screen.queryByRole('button', { name: /google/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});
