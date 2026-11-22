/**
 * UW-10c (ADR 0042) — `email`: the host adapter that carries out `send` and `find_sent` for a generated workflow's binding, through the
 * workspace's connection. One adapter per workspace (it needs that workspace's recipient policy and attachment store), built by the
 * pre-execution host's adapter factory. The tier follows the connection: a Google or Microsoft sign-in is tier 1; an app password
 * whose host is `smtp-host[:port]|imap-host[:port]` is tier 2; with no IMAP part it is tier 3.
 *
 * Mapping to the effect states: a connector error with effect `none` is `confirmed_failure_no_effect`; any other failure is
 * `outcome_unknown`. A failed `find_sent` is ALWAYS `outcome_unknown`: "I could not look" must never read as "it was not sent".
 */
import {
  OAUTH_PROVIDERS,
  revealSecret,
  emailLimitsFromEnv,
  gmailConnector,
  graphConnector,
  smtpMailConnector,
  ConnectorError,
  type AttachmentStore,
  type Connector,
  type EgressPolicy,
  type Json,
  type RecipientPolicy,
  type Secret,
} from '@xo/connectors';
import type { AdapterCredentialHandle, AdapterInvokeRequest, AdapterInvokeResult, ExternalToolAdapter } from '@xo/adapters';

export interface MailAdapterDeps {
  /** Resolved at each call: confirmed-contact addresses plus the workspace's explicit rules. */
  readonly recipientPolicy: () => Promise<RecipientPolicy>;
  readonly attachments: AttachmentStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Tests point these at local fake servers (`allowPrivateNetwork`); production uses the providers' own hosts. */
  readonly endpoints?: { readonly gmail?: string; readonly graph?: string; readonly egress?: Partial<EgressPolicy> };
}

const GMAIL = 'https://gmail.googleapis.com';
const GRAPH = 'https://graph.microsoft.com';

function hostPort(s: string, defaultPort: number): { host: string; port: number } {
  const i = s.lastIndexOf(':');
  const port = i > 0 ? Number(s.slice(i + 1)) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? { host: s.slice(0, i), port } : { host: s, port: defaultPort };
}

/** UW-10: which tier an email connection sends in, whether it can look up a sent message, and what that means, in plain words. */
export interface EmailTierView {
  readonly tier: 'native_api' | 'smtp_imap' | 'send_only';
  readonly lookup: boolean;
  readonly explanation: string;
}

/** Derived from the connection's record (kind, provider, servers, granted scopes); the same rules the adapter applies when it sends. */
export function emailTierOf(c: {
  readonly kind: string;
  readonly provider: string;
  readonly host?: string | undefined;
  readonly scopes: readonly string[];
}): EmailTierView | undefined {
  if (c.kind === 'basic') {
    const imapPart = (c.host ?? '').split('|')[1];
    return imapPart === undefined || imapPart === ''
      ? {
          tier: 'send_only',
          lookup: false,
          explanation:
            'Sends by SMTP only. XO cannot check what was sent, so any uncertain send waits for a person to confirm it, and sending is slower.',
        }
      : {
          tier: 'smtp_imap',
          lookup: true,
          explanation: 'Sends by SMTP and checks the Sent folder over IMAP before deciding anything about an uncertain send.',
        };
  }
  if (c.provider !== 'google' && c.provider !== 'microsoft') return undefined;
  const provider = OAUTH_PROVIDERS[c.provider];
  const granted = new Set(c.scopes.map((s) => provider.normalizeScope(s).toLowerCase()));
  const lookup = provider.capabilityScopes['mail.lookup'].every((s) => granted.has(s.toLowerCase()));
  const name = c.provider === 'google' ? 'Gmail' : 'Microsoft 365 or Outlook';
  return {
    tier: 'native_api',
    lookup,
    explanation: lookup
      ? `Sends through ${name} with the account's sign-in, and looks for a message in the mailbox before deciding anything about an uncertain send.`
      : `Sends through ${name} with the account's sign-in. This connection was not allowed to read the mailbox, so an uncertain send waits for a person to confirm it.`,
  };
}

export function createMailAdapter(deps: MailAdapterDeps): ExternalToolAdapter {
  const egressFor = (host: string): EgressPolicy => ({
    allowedHosts: [host],
    maxRequestBytes: 40 * 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    ...deps.endpoints?.egress,
  });

  const build = async (h: AdapterCredentialHandle): Promise<Connector> => {
    const policy = await deps.recipientPolicy();
    const sender = [h.record.username, h.record.accountLabel].find((x) => x !== undefined && /^[^@\s]+@[^@\s]+$/.test(x));
    if (sender === undefined) throw new ConnectorError('DENIED', 'the connection does not say which address it sends from', 'none');
    const recipientPolicy = (): RecipientPolicy => policy;
    const common = { from: sender, recipientPolicy, attachments: deps.attachments };
    const token = (): string => revealSecret(h.accessToken as Secret);
    if (h.record.kind === 'basic') {
      const [smtpPart = '', imapPart] = (h.record.host ?? '').split('|');
      const tier = imapPart === undefined || imapPart === '' ? 'send_only' : 'smtp_imap';
      const smtp = hostPort(smtpPart, 587);
      const { maxAttachmentBytes, limits } = emailLimitsFromEnv(deps.env, tier);
      const password = revealSecret(h.password as Secret);
      const imap = tier === 'smtp_imap' ? hostPort(imapPart!, 993) : undefined;
      return smtpMailConnector({
        ...common,
        maxAttachmentBytes,
        limits,
        tier,
        smtp: { host: smtp.host, port: smtp.port, security: smtp.port === 465 ? 'tls' : 'starttls' },
        ...(imap !== undefined
          ? { imap: { host: imap.host, port: imap.port, security: 'tls' as const, user: h.record.username ?? sender, password } }
          : {}),
        auth: () => ({ user: h.record.username ?? sender, password }),
      });
    }
    const { maxAttachmentBytes, limits } = emailLimitsFromEnv(deps.env, 'native_api');
    // Lookup only with the `mail.lookup` capability granted (ADR 0041 amended); otherwise an uncertain send waits for a person.
    const canLookup = emailTierOf(h.record)?.lookup === true;
    if (h.record.provider === 'google') {
      const baseUrl = deps.endpoints?.gmail ?? GMAIL;
      return gmailConnector({
        ...common,
        maxAttachmentBytes,
        limits,
        baseUrl,
        egress: egressFor(new URL(baseUrl).hostname),
        accessToken: async () => token(),
        canLookup,
      });
    }
    if (h.record.provider === 'microsoft') {
      const baseUrl = deps.endpoints?.graph ?? GRAPH;
      return graphConnector({
        ...common,
        maxAttachmentBytes,
        limits,
        baseUrl,
        egress: egressFor(new URL(baseUrl).hostname),
        accessToken: async () => token(),
        canLookup,
      });
    }
    throw new ConnectorError('DENIED', 'this connection cannot send email', 'none');
  };

  return {
    id: 'email',
    // Consequential and irreversible: a person approves the exact recipient, subject and attachment hashes (batch approval is UW-8).
    approvalMode: 'payload',
    securityConfig: { contract: 'message.send', tiers: ['native_api', 'smtp_imap', 'send_only'] },
    summarize(input) {
      const to = Array.isArray(input['to']) ? (input['to'] as unknown[]).join(', ') : String(input['to'] ?? '');
      const n = Array.isArray(input['attachments']) ? input['attachments'].length : 0;
      return `Send an email to ${to} (${n} attachment${n === 1 ? '' : 's'})`;
    },
    async invoke(req: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
      const op = req.capabilityId.slice(req.capabilityId.lastIndexOf('.') + 1);
      const lookup = op === 'find_sent';
      const noEffect = (code: string, message: string): AdapterInvokeResult => ({ kind: 'confirmed_failure_no_effect', code, message });
      if (op !== 'send' && !lookup) return noEffect('unsupported_operation', 'the email adapter carries out send and find_sent only');
      if (req.credential === undefined)
        return lookup
          ? { kind: 'outcome_unknown', reason: 'no connection to look in' }
          : noEffect('no_connection', 'no email connection is bound');
      let reached = false; // once the operation runs, anything that fails may have sent
      try {
        return await req.credential.use(async (h) => {
          const operation = (await build(h)).operations[op];
          if (operation === undefined)
            return {
              kind: 'outcome_unknown',
              reason: 'this connection cannot look up sent mail; a person must confirm',
            } satisfies AdapterInvokeResult;
          reached = true;
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 5 * 60_000);
          try {
            const output = await operation.execute(lookup ? { key: req.dispatchKey } : (req.input as Readonly<Record<string, Json>>), {
              idempotencyKey: req.dispatchKey,
              runId: '',
              stepId: '',
              secret: () => '',
              signal: ctl.signal,
            });
            return { kind: 'confirmed_success', output } satisfies AdapterInvokeResult;
          } finally {
            clearTimeout(timer);
          }
        });
      } catch (e) {
        if (e instanceof ConnectorError) {
          if (lookup || e.effect !== 'none')
            return {
              kind: 'outcome_unknown',
              reason: lookup ? 'the sent message could not be confirmed' : 'the send may or may not have reached the mail server',
            };
          // RX-1c: a provider "slow down" carries the pause it asked for, so the engine can try again within the step deadline.
          if (e.code === 'RATE_LIMITED')
            return { kind: 'confirmed_failure_no_effect', code: 'rate_limited', message: e.message, retryAfterMs: e.retryAfterMs ?? 2_000 };
          return noEffect(String(e.code).toLowerCase(), e.message);
        }
        // Not ours (for example the connection could not be used): nothing was sent, but only if we never reached the send.
        const message = e instanceof Error ? e.message : 'failed';
        if (lookup || reached)
          return {
            kind: 'outcome_unknown',
            reason: lookup ? 'the lookup failed' : 'the send failed unexpectedly and may have reached the mail server',
          };
        return noEffect('connection_unusable', message);
      }
    },
  };
}
