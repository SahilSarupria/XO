# `xo serve` hardening: what exists, what is tested, what is not claimed

**This is not a claim that `xo serve` is ready to face the public internet.** It describes the controls that make exposure _possible to do carefully_, the tests behind them, and the gaps. A real
external exposure still needs an independent security review, network-level controls (firewall, allowlist, WAF or reverse proxy), and operational monitoring that no code in this repository provides.

## Defaults and refusals (the server will not start into an unsafe configuration)

| Situation                                                                              | Result                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| no `--tokens` and no `XO_SERVER_TOKEN`                                                 | refuses to start                                    |
| non-loopback `--host` without `--allow-remote`                                         | refuses                                             |
| non-loopback with the legacy shared `XO_SERVER_TOKEN`                                  | refuses (it cannot expire, be revoked or be scoped) |
| non-loopback without built-in TLS **and** without `--behind-tls-proxy`                 | refuses                                             |
| `--tls-*` together with `--behind-tls-proxy`                                           | refuses (alternatives)                              |
| `--require-client-cert` without `--tls-ca`                                             | refuses                                             |
| token file readable by group/others, malformed, unknown scope or key, duplicate client | refuses to open                                     |

`--behind-tls-proxy` is **your statement** that something you operate terminates TLS in front and that the hop to this port is private. Nothing here can verify it. It exists so a plaintext remote binding is a deliberate act.

## Authentication and scopes

`xo token create <id> --scopes … (--ttl 30d | --no-expiry) --tokens <file>` prints a token **once** (`xo_` + 43 base64url characters = 256 bits). Only its SHA-256 is stored, in a 0600 file replaced atomically. Clients have
scopes, an optional expiry, and can be revoked (at once, or at a future time to overlap a rotation). `xo token rotate` issues a new token with the same scopes. `xo token list` never prints a token. The server re-checks the file about
once a second, so **revocation reaches a running server** without a restart. A token file that becomes unreadable or invalid **denies everything** (and says so in the audit log only).

| Scope         | Routes                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| (public)      | `GET /v1/health`, exactly                                                                                                                |
| `read`        | `POST /v1/decide`, `POST /v1/loader/resolve`, `GET /v1/receipts`, `GET /v1/runs/:id`, `GET /v1/workflows/:id/runs`, `GET /v1/approvals…` |
| `run`         | `POST /v1/workflows/:id/runs`                                                                                                            |
| `lease`       | `POST /v1/runs/:id/lease`                                                                                                                |
| `ledger-sync` | `GET`/`POST /v1/ledger/:id`                                                                                                              |
| `approve`     | `POST /v1/approvals…`                                                                                                                    |
| `event`       | `POST /v1/events` (inbound event for a `wait` step; other methods on that path are `admin`)                                              |
| `admin`       | satisfies any scope, and is the only scope for a route not listed above (**deny by default**)                                            |

The scope is decided from method and path **before** any body is read. The only accepted credential is `Authorization: Bearer <token>` with a single space; the query string, cookies and other headers are ignored. A refusal never says whether a token
was unknown, expired or revoked (the audit log does).

## Transport

Built-in TLS (`--tls-cert`, `--tls-key`; TLS 1.2+ via Node's `https`) with certificates **you** supply and rotate (changing them needs a restart). `--tls-ca` + `--require-client-cert` adds mutual TLS: a client without a certificate signed by that CA cannot
complete the handshake. mTLS is **in addition to** the bearer token, not instead of it, and a client certificate's identity is not bound to a token. HSTS is sent only over TLS.

## Abuse limits and headers

Per-address request rate limit **before** authentication (default 240/min); failed-authentication limit per address (default 10/min; beyond it failures are answered 429 `AUTH_LOCKED`, a valid token still works); only `GET` and `POST` are accepted
(`OPTIONS`, `HEAD`, `PUT`, `DELETE`, `PATCH`, `TRACE` get 405 before authentication, with no CORS headers); 1 MiB body cap (413) enforced on declared and streamed length; JSON only (415); URL ≤ 2 kB; header block ≤ 16 kB and ≤ 50 headers; request deadline 30 s,
header deadline 10 s, keep-alive 5 s; a refused request closes its connection without reading its body. Responses carry `no-store`, `nosniff`, `X-Frame-Options: DENY`, a `default-src 'none'` CSP, `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy`. CORS is **off**: no `Access-Control-*` header is ever sent.

## Audit log

`--audit-log <file>` appends JSON Lines (0600) for: authentication failures (with the reason), lockouts, scope violations (client and needed scope), rate limiting, TLS handshake failures and an unavailable token store. Events never contain a credential, a header value
or the query string, and control characters are stripped so a hostile path cannot forge a line. There is no log rotation and no tamper evidence: ship it off the host.

## What is tested (and how)

`packages/server/test/hardening.test.ts` (64 tests, real sockets, real TLS with certificates generated by `openssl` at test time) and `apps/cli/test/token-serve.test.ts` (real `xo serve` child processes): the scope matrix for every route and every token kind (and that the handler is never reached when refused);
escalation attempts through the body, headers, query string, dot segments and method-override headers; 16 authentication-bypass variants and look-alike health paths; verb refusal and absence of CORS headers; expired, revoked and future-revoked tokens; live revocation and rotation; a corrupt or too-permissive token file;
lockout and its audit trail (no credentials, no forged lines); pre-authentication rate limiting; oversized (declared and chunked) and unauthenticated-huge bodies; trickled headers and bodies (slowloris); TLS, plaintext-to-TLS, untrusted CA, mutual TLS with no/foreign/valid client certificates; and every construction-time refusal.
The guards were mutation-checked (removing each makes a test fail).

## Not covered / known gaps

- **No independent review.** None of this has been assessed by anyone but its authors.
- Rate limits and lockout are **per remote address, in process memory**. Behind a proxy the address is the proxy's, so one attacker can lock out every client; enforce limits at the proxy as well. Not shared across instances; restart clears them. The tables are size-bounded (oldest dropped), which is tested only by reading the code.
- Bearer tokens can be replayed by anyone who captures one; the defences are TLS, short expiry, revocation and scopes. There is no request signing or nonce. A replayed mutating request is deduplicated by the runner's idempotent run ids (tested in the runtime), not by the server.
- TLS certificates are loaded at start; there is no hot reload, no OCSP and no certificate pinning. The test certificates are throwaway; nothing here checks the strength of yours.
- Header-level trust of a proxy (`X-Forwarded-*`) is deliberately **not** implemented.
- No per-client rate limit (only per address), no token binding to a client certificate or IP, no audit-log rotation or signing, no web UI or HTTP token-management API (tokens are managed with `xo token` on the host).
- The container image runs as an unprivileged user but is otherwise not hardened (no read-only root filesystem, no seccomp profile).
