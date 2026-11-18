import { resolveMx } from 'node:dns/promises';
import type { MailTier } from './connectors.js';

/**
 * UW-10 (ADR 0041) — guess the mail provider from the sender's domain and say, in plain words, what XO can do with it.
 * Known-provider table first, then an MX lookup (a custom domain hosted at Google or Microsoft), else "manual": the person fills in
 * the SMTP (and optionally IMAP) host. Auto-configuration discovery (ISPDB, autodiscover) is deferred.
 *
 * The table records what XO's own tiers need, not provider guarantees: hosts change their rules (OAuth, app passwords, SMTP AUTH),
 * which is why the guess is a starting point a person confirms, and the tier is what the preview shows.
 */
export interface ProviderGuess {
  readonly provider: 'google' | 'microsoft' | 'yahoo' | 'zoho' | 'manual';
  readonly tier: MailTier;
  readonly how: 'known_domain' | 'mx' | 'manual';
  /** Plain words for the preview and the connection screen. */
  readonly explanation: string;
}

const KNOWN: Readonly<Record<string, ProviderGuess['provider']>> = {
  'gmail.com': 'google',
  'googlemail.com': 'google',
  'outlook.com': 'microsoft',
  'hotmail.com': 'microsoft',
  'live.com': 'microsoft',
  'office365.com': 'microsoft',
  'yahoo.com': 'yahoo',
  'ymail.com': 'yahoo',
  'zoho.com': 'zoho',
  'zohomail.com': 'zoho',
};

const TEXT: Readonly<Record<ProviderGuess['provider'], { tier: MailTier; explanation: string }>> = {
  google: { tier: 'native_api', explanation: 'Sends through Gmail with your sign-in. XO can check whether a message was sent only if you also allow reading your mailbox; otherwise an uncertain send waits for you to confirm it.' },
  microsoft: { tier: 'native_api', explanation: 'Sends through Microsoft 365 or Outlook with your sign-in. XO can check whether a message was sent only if you also allow reading your mailbox; otherwise an uncertain send waits for you to confirm it.' },
  yahoo: { tier: 'smtp_imap', explanation: 'Sends by SMTP and checks your Sent folder over IMAP before deciding anything about an uncertain send. Needs an app password.' },
  zoho: { tier: 'smtp_imap', explanation: 'Sends by SMTP and checks your Sent folder over IMAP before deciding anything about an uncertain send.' },
  manual: { tier: 'send_only', explanation: 'Sends by SMTP only. XO cannot check what was sent, so any uncertain send waits for you to confirm it, and sending is slower.' },
};

const guess = (provider: ProviderGuess['provider'], how: ProviderGuess['how']): ProviderGuess => ({ provider, how, ...TEXT[provider] });

export async function guessProvider(
  address: string,
  deps: { readonly mx?: (domain: string) => Promise<readonly string[]> } = {},
): Promise<ProviderGuess> {
  const at = address.lastIndexOf('@');
  const domain = at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
  if (domain === '') return guess('manual', 'manual');
  const known = KNOWN[domain];
  if (known !== undefined) return guess(known, 'known_domain');
  const mx = deps.mx ?? (async (d: string) => (await resolveMx(d)).map((r) => r.exchange));
  try {
    const hosts = (await mx(domain)).map((h) => h.toLowerCase().replace(/\.$/, ''));
    if (hosts.some((h) => h.endsWith('.google.com') || h.endsWith('.googlemail.com'))) return guess('google', 'mx');
    if (hosts.some((h) => h.endsWith('.protection.outlook.com') || h.endsWith('.outlook.com'))) return guess('microsoft', 'mx');
    if (hosts.some((h) => h.endsWith('.zoho.com') || h.endsWith('.zoho.in'))) return guess('zoho', 'mx');
  } catch {
    /* no MX answer: fall through to manual */
  }
  return guess('manual', 'manual');
}
