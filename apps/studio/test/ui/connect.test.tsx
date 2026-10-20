import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

describe('sign-in screen (design: split layout)', () => {
  it('shows the sign-in heading and the access-key form beside a decorative hero', () => {
    const api = new FakeXo();
    const { container } = render(withShell(<App fetchImpl={api.fetch} />));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText(/access key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
    const hero = container.querySelector('.connect-hero');
    expect(hero).not.toBeNull();
    expect(hero?.getAttribute('aria-hidden')).toBe('true'); // decorative: never read out, never focusable content
    expect(hero?.querySelector('button, a, input')).toBeNull();
  });

  it('keeps the privacy promise visible in the form column', () => {
    render(withShell(<App fetchImpl={new FakeXo().fetch} />));
    expect(screen.getByText(/your documents stay yours/i)).toBeInTheDocument();
  });
});
