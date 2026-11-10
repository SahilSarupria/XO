# Connectors (`@xo/connectors`)

The only path from a workflow to the outside world. Implemented: framework, grants, dry-run, secret vault + redaction, **HTTP**, **file**, **MCP client** and **SMTP** connectors.
**Not implemented yet:** Slack webhook, webhook-out, database, sandboxed code steps, external-vault adapters, durable retries/breakers (section C). Nothing here is measured.

## Order of checks (every one fails closed)

declared in the signed manifest -> granted in the operator policy -> implementation of the declared kind installed -> side-effect class agrees
-> declared secrets resolvable -> idempotency key present for side effects -> dry-run gate -> execute under a timeout (capped by the host).
Every call yields a `CallRecord` with request hash, response hash, duration and outcome (no bodies) for the ledger. Results are
`{ untrusted: true, provenance, data }`: text inside them is data, never instructions.

## Operator policy (local file, never shipped in the package)

```json
{ "connectors": { "api": { "grant": ["get"] }, "files": { "grant": ["write_record"] } } }
```

Endpoints, roots and credentials bind on the host: `httpConnector({ baseUrl, methods, pathPatterns, maxResponseBytes, bearerSecret })`,
`fileConnector({ roots: { out: '/var/xo/out' }, maxBytes })`. Secrets come from a `SecretVault` (`EnvVault` reads `XO_SECRET_<NAME>`, `FileVault`, `MapVault`);
`Redactor` strips every secret value from results, errors and records.

## HTTP hardening

Workflows pass a path only (never a host, headers or auth). Path must match an allowed pattern; traversal (including percent-encoded), `//`, backslashes
and query smuggling are refused. Hosts resolving to private/loopback/link-local/CGNAT/unique-local addresses (incl. v4-mapped v6) are refused unless
`allowPrivateNetwork` (dev only). Redirects are refused. Response size is enforced while streaming. Write calls send `Idempotency-Key`.
**Limit:** the address is checked at resolution time and the request then connects by hostname, so a DNS rebinding race is not fully closed; pin to an
egress proxy for hostile networks.

## File hardening

Logical roots only; lexical checks plus `realpath` confinement (symlink escapes refused). `write_record` is create-only via atomic `link`: an identical
replay is a no-op, different content is refused, and a crash never leaves a half-written target.

`createRoots` (default **off**) lets the connector create a missing root directory (mode 0700) on the first **write**; reads never create anything and the
filesystem root is never created or used. It exists so an operator does not have to `mkdir` before the first run, while a typo in a bound path still fails
closed by default. `xo flow run` / `xo serve` turn it on, because the root path comes from the operator's own policy file. Library users opt in explicitly.

## Tests

`packages/connectors/test/connectors.test.ts` (17): ungranted/undeclared refusal, dry-run, secret redaction, prompt-injection text inert, SSRF, traversal,
redirects, size limits, timeouts, symlink escape.

## MCP client (`mcpConnector`)

Transports: stdio (newline-delimited JSON-RPC) and streamable HTTP (JSON or SSE responses, session id carried). Operator config names each allowed tool, maps it to a
workflow operation and **declares its side-effect class** (the manifest and the operator's declaration must agree or the call is refused; treat unknown tools as `write`).
Only listed tools are callable, even if the server offers more (`delete_all` in the tests is unreachable). Arguments are validated against the tool's own input schema first;
a schema using keywords the validator does not support (`anyOf`, `$ref`, ...) is **refused, not skipped**. Results are capped, returned as untrusted data with provenance,
secrets are injected from the vault into the child environment or bearer header and redacted from results, and every call is hashed into the ledger like any connector call.
Tool-reported errors become refusals. HTTP requires https (or an explicit private-network opt-in), refuses redirects, and applies the same private-address check as the HTTP connector.

**Confinement (read this).** A stdio MCP server is launched only inside a confinement plan (`planConfinement`, `packages/connectors/src/confine.ts`); there is no unconfined default. The
connector refuses to be built without a plan, and planning refuses rather than return a weaker plan than the policy allows. Levels, each reporting what it protects and what it does not:

| Level                                      | Host needs                                                                                   | Protects                                                                                                                                                                                                                                                                         | Does **not** protect                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bwrap` (default)                          | Linux + bubblewrap                                                                           | filesystem is an allow-list (system dirs read-only, plus the operator's `readOnlyPaths` / `writablePaths`; no home, run directory or secrets), no network (unless `network: host`), own PID/IPC/UTS namespaces, private `/proc`, `/dev`, `/tmp`, own session, dies with the host | CPU/memory/disk quotas, kernel or bwrap escapes, what the server does with data it is given |
| `namespaces` (needs `require: namespaces`) | Linux + unprivileged `unshare`                                                               | no network, cannot see or signal other processes, separate IPC/hostname                                                                                                                                                                                                          | **files: the child can read and write anything the host user can**                          |
| `operator-wrapper`                         | operator-supplied argv                                                                       | nothing is claimed (XO cannot verify it)                                                                                                                                                                                                                                         | everything is the operator's responsibility                                                 |
| `none`                                     | `confine: {allowUnconfined: true}` (only if confinement is unavailable) or `{disable: true}` | nothing                                                                                                                                                                                                                                                                          | filesystem, network, processes                                                              |

On macOS and Windows no confinement exists: binding an MCP stdio server there is refused unless the operator opts in, and the plan then says exactly what is unprotected. In the CLI an
`mcp` binding takes `command`, `args`, `env`, `cwd`, `tools` (operation to `{tool, sideEffect}`; an omitted side effect means `write`), `maxResponseBytes`, an optional `confine` block
(`require`, `allowUnconfined`, `disable`, `network`, `readOnlyPaths`, `writablePaths`, `operatorWrapper`), or `url`/`bearerSecret`/`allowPrivateNetwork` for an HTTP server. Unknown keys and
contradictions are errors. The confinement record of every stdio server (kind, platform, opt-out, reason, protects, not-protected) is written into the `run_started` entry of every run
(`environment.mcpConfinement`), and an opt-out also prints a warning. "Code-bearing steps": the workflow runner never evaluates code (expressions go through the interpreter, rules and trees
through the existing evaluators); the only things XO launches are MCP stdio servers, so this is the one place a process boundary applies. Tested: a hostile child cannot reach the network or signal a host process under
`namespaces` (and, where bubblewrap exists, cannot read a secret file); those bubblewrap cases are **skipped, with a message, on hosts without bubblewrap** — they were skipped in the
environment this was built in, so the bwrap argument list is covered only by unit assertions and one probe, not by a real run. A real MCP call through `unshare` is tested.

Not implemented: MCP resources/prompts, server-initiated requests (ignored), per-server rate limits, restarting a crashed server mid-run beyond the next call.

## SMTP (`smtpConnector`, `nodeSmtpTransport`)

Operation `send` (write): `{ to, subject, body }`. Recipients must be in `allowedRecipientDomains` (an empty list refuses everything), at most 5 by default; CR/LF/NUL in any
field is refused (header injection); the body is sent base64 so it cannot inject headers or end DATA early. Transport is injectable. The built-in one speaks SMTP over implicit TLS or
STARTTLS (TLS 1.2+), **refuses to send credentials or continue in clear text**, and treats 5xx replies as permanent refusals. `security: 'none'` exists only for loopback test servers.
**No idempotency in SMTP:** the Message-ID is derived from the idempotency key so receivers can dedupe, but a retry after an ambiguous failure can deliver two copies.
Not implemented: attachments, HTML bodies, certificate pinning, DKIM, OAuth, bounce handling. Tested against a fake loopback server only; **not tested against a real mail server**.
`connectorApprovalSink` / `connectorEscalationSink` (`@xo/workflow-runtime`) deliver approval requests and escalations through any such connector via the same grants; a delivery failure throws.
Slack-compatible webhook, webhook-out and database connectors are **not implemented**.

## Operator bindings (`--policy`, key `bindings`)

A package declares connectors by id and kind only. The operator's policy file binds each id: `"bindings": { "<id>": { ... } }`, with the settings of that
connector's kind. `fileRoots` (older spelling) still works for file connectors. Unknown keys, bindings for ids the package does not declare, a binding named
in both spellings, malformed values and unbuildable connectors are **errors at start-up** that name the binding; a declared connector with no binding has no
implementation, so calling it fails closed. Bindable today: `file`, `http`, `webhook_out`, `slack_webhook`, `database` (sqlite), `smtp`. Not yet: `mcp` (see item 4).

## Outbound webhooks (`webhook_out`, `slack_webhook`) and `egress`

Both send to a destination the **operator** binds; a workflow can never name a host, path, header or method (any extra argument is refused). Both go through `egress`:

1. https only (plain http only with `allowPrivateNetwork`, for local development);
2. no credentials in the URL (`https://allowed@evil/`);
3. the host is on `allowedHosts` — exact, or `*.suffix` for subdomains (never a substring; the apex is not a subdomain). IP addresses are refused as allowlist entries;
4. the port is the scheme default unless listed in `allowedPorts`;
5. the name is resolved **once**; every returned address must be public (a name with one public and one private record is refused; IPv4-mapped, NAT64, 6to4,
   Teredo and documentation IPv6 ranges are refused);
6. the connection goes to that **vetted address** (with the original `Host` and TLS name), so a second DNS answer cannot redirect it. This closes the DNS-rebinding
   race for these connectors. **The older `http` connector still resolves and then connects by name, so that race is still open there.**
7. redirects are refused; request and response sizes and the whole exchange (abort signal) are bounded.

`webhook_out` — operation `post` (write): `{ body, event? }`. Sends JSON with an `idempotency-key` header and, when `signingSecret` (a declared secret _name_) is set,
`x-xo-timestamp` and `x-xo-signature: v1=HMAC-SHA256(key, "<timestamp>.<raw body>")`. The **receiver** must reject old timestamps (replay) and compare in constant
time. 5xx is a retryable failure; 4xx is returned as `ok: false`. `slack_webhook` — operation `post_message` (write): `{ text }`. The incoming-webhook **URL is a
secret** (`webhookSecret` names it); default allowlist `hooks.slack.com`, extend it for Slack-compatible receivers. Text is escaped (`& < >`), so untrusted case text
cannot carry `<!channel>`, `<@U…>` or disguised links; over-long text is refused, not cut. Errors never contain the URL or signing key (scrubbed). Not covered:
Slack blocks/attachments/threads, and delivery confirmation beyond the HTTP status (idempotency depends on the receiver honouring the key; see item 8).

## Read-only database (`database`)

Operation `query` (read): `{ statement: <id>, params?: { name: value } }`. A workflow never sends SQL: it names an operator-declared statement and supplies its typed
parameters (`string`, `integer`, `number`, `boolean`, optionally nullable), bound **positionally** by the driver, never spliced into SQL. Every statement is vetted when
the connector is built — one statement, starts with `SELECT`/`WITH`, comments and quoted text stripped before the keyword check, no write/DDL/session/file/sleep
words, no backslash or dollar quoting, placeholders match the declared parameters — and a bad statement stops start-up. Rows (default 1000, hard 100 000), result bytes
and time are bounded; a result over the row limit is **refused** unless `onOverflow: "truncate"`. Driver errors are reduced to a coarse class (they can carry connection
strings or the bound values). **The real boundary is a database role that can only SELECT; only the operator can create it.** The bundled SQLite driver
(`{"driver":{"type":"sqlite","path":"..."}}`, Node's experimental `node:sqlite`) opens the file read-only at the engine and refuses to create a missing file, but its
API is synchronous, so a slow query cannot be interrupted: use it for local files. Networked databases are supplied by an embedding application as a `DbDriver`
(none ships). Not covered: write operations (refused by the IR validator), result-set joins across databases, row-level access control.
