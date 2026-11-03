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

**Sandbox limits (read this):** a stdio MCP server is an ordinary child process started with a cleared environment, no shell, and an operator-chosen working directory. This code
does **not** confine its filesystem or network access. `sandboxWrapper` lets the operator prefix a real sandbox (for example `bwrap` or a container runner); on macOS and Windows no
equivalent is provided here. The existing Node permission-model sandbox in `@xo/automation` applies to code evaluation, not to arbitrary MCP server commands, and is **not** wired to MCP.
Not implemented: MCP resources/prompts, server-initiated requests (ignored), per-server rate limits, restarting a crashed server mid-run beyond the next call.

## SMTP (`smtpConnector`, `nodeSmtpTransport`)

Operation `send` (write): `{ to, subject, body }`. Recipients must be in `allowedRecipientDomains` (an empty list refuses everything), at most 5 by default; CR/LF/NUL in any
field is refused (header injection); the body is sent base64 so it cannot inject headers or end DATA early. Transport is injectable. The built-in one speaks SMTP over implicit TLS or
STARTTLS (TLS 1.2+), **refuses to send credentials or continue in clear text**, and treats 5xx replies as permanent refusals. `security: 'none'` exists only for loopback test servers.
**No idempotency in SMTP:** the Message-ID is derived from the idempotency key so receivers can dedupe, but a retry after an ambiguous failure can deliver two copies.
Not implemented: attachments, HTML bodies, certificate pinning, DKIM, OAuth, bounce handling. Tested against a fake loopback server only; **not tested against a real mail server**.
`connectorApprovalSink` / `connectorEscalationSink` (`@xo/workflow-runtime`) deliver approval requests and escalations through any such connector via the same grants; a delivery failure throws.
Slack-compatible webhook, webhook-out and database connectors are **not implemented**.
