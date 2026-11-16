# Configuration reference

<!-- Generated from packages/instance/src/settings.ts by `node --import tsx packages/instance/scripts/render-config-doc.ts`. Do not edit by hand. -->

Every setting an XO instance reads. Settings come from environment variables, then the config file (`XO_CONFIG_FILE`, default
`xo.env` in the data directory), then the encrypted secrets file for secrets. The instance checks all of them at start-up and
reports every problem at once; a name that looks like an XO setting but is not one is reported with the closest known name.

With `XO_DATA_DIR` set, every storage setting defaults to a folder inside it ("In data dir" below), so one directory holds all
state. A storage setting for a feature that is off stays unset.

## Server

| Setting | Accepts | Default | In data dir | What it does |
| --- | --- | --- | --- | --- |
| `PORT` | integer 1–65535 | 4000 |  | Port the instance listens on. |
| `HOST` | string | 127.0.0.1 |  | Address to listen on. Keep loopback unless a proxy you operate sits in front (a container needs 0.0.0.0). |
| `XO_PUBLIC_BASE_URL` | https URL |  |  | The address people use to reach this instance (https, except on loopback). Printed by xo up, used for links, and its /auth/callback is an allowed sign-in return address. |
| `XO_API_TRUSTED_PROXY_HOPS` | integer 0–5 | 0 |  | Reverse proxies you control in front of the instance, so rate limits see the real client address. |
| `XO_STUDIO_DIR` | path |  |  | A built Studio (apps/studio/dist) to serve at / on the same port, with the API under /api. Unset: API only. |
| `XO_DEV_SIGN_IN` | 1 \| true \| 0 \| false | 1 |  | Show the access-key sign-in in the served Studio. Set 0 once another sign-in works. |
| `XO_ENV` | development \| test \| production | development |  | Deployment environment. production makes several safeguards mandatory. |
| `NODE_ENV` | string |  |  | production makes platform audit storage mandatory and refuses development package trust. |

## Storage (one data directory)

| Setting | Accepts | Default | In data dir | What it does |
| --- | --- | --- | --- | --- |
| `XO_DATA_DIR` | path |  |  | The instance data directory. Every storage setting below defaults to a folder inside it. |
| `API_KEYS_DIR` | path | .xo-data/api-keys | `api-keys` | Access keys (hashes only). |
| `WORKSPACES_DIR` | path | .xo-data/workspaces | `workspaces` | Workspace records (who owns which workspace). |
| `WORKSPACE_DATA_DIR` | path | .xo-data/workspace-data | `workspace-data` | Everything inside workspaces: sources, compilations, packages, runs, workspace audit logs. |
| `XO_API_SESSIONS_DIR` | path |  | `sessions` | Google sign-in sessions. |
| `XO_API_ACCOUNTS_DIR` | path |  | `accounts` | Password sign-in accounts (argon2id hashes). |
| `XO_API_PASSWORD_BINDINGS_DIR` | path |  | `oidc-bindings` | Password identity bindings (shared with Google sign-in, which requires the same folder). |
| `XO_API_PASSWORD_SESSIONS_DIR` | path |  | `sessions` | Password sign-in sessions (shared with Google sign-in, which requires the same folder). |
| `XO_API_OIDC_BINDINGS_DIR` | path |  | `oidc-bindings` | Which organisation identity maps to which XO identity. |
| `XO_EXTERNAL_EFFECTS_DIR` | path |  | `external-effects` | Durable evidence of every external effect dispatched (one filesystem, shared by every worker). |
| `XO_INFERENCE_CACHE_DIR` | path |  | `inference-cache` | Cached model answers. |
| `XO_SECRETS_FILE` | path |  | `secrets.enc` | Encrypted secrets file (xo secrets set). Its key is kept outside the data directory. |
| `XO_SECRETS_KEY_FILE` | path |  |  | Where the key for the secrets file lives. Keep it out of the data directory and out of its backups. |
| `XO_SECRETS_KEY` (secret) | string |  |  | The secrets-file key itself (base64, 32 bytes), for hosts that inject it as an environment variable. |

## Sign-in

| Setting | Accepts | Default | In data dir | What it does |
| --- | --- | --- | --- | --- |
| `XO_API_OIDC_ISSUER` | URL |  |  | Accept bearer tokens from this OIDC issuer. |
| `XO_API_OIDC_AUDIENCE` | string |  |  | The audience those tokens must carry. |
| `XO_API_OIDC_JWKS_URI` | URL |  |  | The issuer signing keys. |
| `XO_API_OIDC_CLOCK_SKEW_SECONDS` | integer 0–120 | 30 |  | Allowed clock skew. |
| `XO_API_GOOGLE_CLIENT_ID` | string |  |  | Google sign-in OAuth client id (public). |
| `XO_API_GOOGLE_CLIENT_SECRET` (secret) | string |  |  | That client secret. Read by the instance only, to redeem sign-in codes. |
| `XO_API_GOOGLE_ISSUER` | URL |  |  | Override of the Google issuer (tests). |
| `XO_API_GOOGLE_JWKS_URI` | URL |  |  | Override of the Google signing keys (tests). |
| `XO_API_GOOGLE_TOKEN_URI` | URL |  |  | Override of the Google token endpoint (tests). |
| `XO_API_SELF_SIGNUP` | 1 \| true \| 0 \| false | 0 |  | Anyone with a verified account may sign in. |
| `XO_API_SELF_SIGNUP_MAX_PER_DAY` | integer 1–1000000 | 200 |  | New self-created accounts per rolling 24 hours. |
| `XO_API_PASSWORD_AUTH` | 1 \| true \| 0 \| false | 0 |  | Offer password sign-in. |
| `XO_API_PASSWORD_HASH_CONCURRENCY` | integer 1–16 | 2 |  | Parallel password hashes. |
| `XO_API_PASSWORD_HASH_QUEUE_LIMIT` | integer 0–1024 | 32 |  | Waiting hashes. |
| `XO_API_PASSWORD_ARGON2_TIME_COST` | integer 2–10 | 3 |  | argon2id time cost. |
| `XO_API_PASSWORD_ARGON2_MEMORY_KIB` | integer 19456–1048576 | 65536 |  | argon2id memory cost. |
| `XO_API_KEY_MAX_AGE_DAYS` | integer 1–3650 | 365 |  | Maximum age of an access key issued without an expiry. |
| `XO_API_STEP_UP_MAX_AGE_MINUTES` | integer 0–1440 | 15 |  | Approvals and membership changes need a sign-in this recent (0 turns step-up off). |

## Audit

| Setting | Accepts | Default | In data dir | What it does |
| --- | --- | --- | --- | --- |
| `XO_AUDIT_DIR` | path |  | `audit` | Durable platform audit store. Set with both retention settings, or none of them. |
| `XO_API_AUDIT_RETENTION_DAYS` | integer 1–36500 |  |  | Declared retention of workspace audit logs. Unset: none declared, nothing may be purged. |
| `XO_AUDIT_RETENTION_DAYS` | number 0.001–36500 |  |  | Platform audit default retention (days). |
| `XO_AUDIT_MIN_RETENTION_DAYS` | number 0.001–36500 |  |  | Platform audit minimum retention (days). |
| `XO_AUDIT_ANCHOR_DIR` | path |  |  | Where each workspace audit chain head is anchored. Put it on storage this host cannot rewrite, never inside the data directory. |

## Package trust

| Setting | Accepts | Default | In data dir | What it does |
| --- | --- | --- | --- | --- |
| `XO_TRUST_MODE` | enforce \| development | enforce |  | development turns package signature verification off (local development only). |
| `XO_PACKAGE_TRUST_POLICY` | path |  |  | The package trust policy file (trusted signers). |

## Models

| Setting | Accepts | Default | In data dir | What it does |
| --- | --- | --- | --- | --- |
| `XO_INFERENCE_PROVIDER` | none \| gemini | none |  | Compile-time inference provider. |
| `GEMINI_API_KEY` (secret) | string |  |  | Gemini key. |
| `XO_GEMINI_MODEL` | string |  |  | Gemini model id. |
| `XO_GEMINI_TIMEOUT_MS` | integer 1000–300000 | 30000 |  | Gemini request timeout. |
| `XO_GEMINI_MAX_OUTPUT_TOKENS` | integer 1–65536 | 8192 |  | Output token cap. |
| `XO_GEMINI_TEMPERATURE` | number 0–2 |  |  | Default temperature. |
| `XO_GEMINI_MAX_RETRIES` | integer 0–5 | 2 |  | Retries after the first attempt. |
| `XO_GEMINI_ACK_DATA_USE_TERMS` | 1 \| true \| 0 \| false | false |  | Required in production: you checked Google data-use terms for your key tier. |
| `ANTHROPIC_API_KEY` (secret) | string |  |  | Anthropic key (chat, vision reading). |
| `OPENAI_API_KEY` (secret) | string |  |  | OpenAI key. |
| `AZURE_OPENAI_API_KEY` (secret) | string |  |  | Azure OpenAI key. |
| `AZURE_OPENAI_ENDPOINT` | URL |  |  | Azure OpenAI endpoint. |
| `OLLAMA_BASE_URL` | URL |  |  | A local Ollama server. |
| `XO_API_OLLAMA_ENABLED` | 1 \| true \| 0 \| false |  |  | Offer Ollama at its default address. |
| `XO_COMPILER_MAX_COST_USD` | number 0–10000 |  |  | Spend limit per compile. |
| `XO_COMPILER_MAX_TOTAL_TOKENS` | integer 1–1000000000 |  |  | Token limit per compile. |
| `XO_COMPILER_ALLOW_UNBOUNDED_INFERENCE` | 1 \| true \| 0 \| false |  |  | Compile with inference and no spend limit (explicit only). |
| `XO_COMPILER_ESCALATION_MODE` | gated \| always | gated |  | When the compiler asks a model. |
| `XO_COMPILER_ESCALATION_CONFIDENCE_THRESHOLD` | number 0–1 |  |  | Escalation confidence floor. |
| `XO_COMPILER_ESCALATION_AMBIGUITY_MARGIN` | number 0–1 |  |  | Escalation ambiguity margin. |
| `XO_COMPILER_ESCALATION_MIN_CONTENT_WORDS` | integer 0–100000 |  |  | Escalation minimum words. |

## Reading scans and photos

| Setting | Accepts | Default | In data dir | What it does |
| --- | --- | --- | --- | --- |
| `XO_OCR` | local \| off | local |  | Read scanned pages and photos on this machine. |
| `XO_OCR_WORKERS` | integer 1–16 | 2 |  | OCR worker threads. |
| `XO_OCR_VISION_PROVIDER` | string |  |  | Vision reading provider (off unless set). |
| `XO_OCR_VISION_MODEL` | string |  |  | Vision reading model. |
| `XO_OCR_VISION_SENDS_IMAGES` | yes |  |  | Confirms page images and photos may be sent to the vision provider. |
| `XO_OCR_MAX_COST_USD` | number 0–100 | 0 |  | Vision spend per document. |

## Workflows

| Setting | Accepts | Default | In data dir | What it does |
| --- | --- | --- | --- | --- |
| `XO_SCHEDULER` | on \| off | on |  | Fire schedule triggers from this instance. One instance per data directory runs them. |
| `XO_PROCEDURE_STEP_TIMEOUT_MS` | integer 1–9999999999 |  |  | Per-step timeout for procedures. Unset: none. |
| `XO_API_RUNTIME_LOCATIONS` | string |  |  | Where workflows may run, as shown in settings. |
| `XO_SANDBOX_NET_GUARD` | 1 \| true \| 0 \| false |  |  | Set by the sandbox for its own workers. |
| `XO_SANDBOX_TEST_HOOKS` | string |  |  | Test-only sandbox hooks. |

## Operations

| Setting | Accepts | Default | In data dir | What it does |
| --- | --- | --- | --- | --- |
| `XO_LOG_LEVEL` | debug \| info \| warn \| error | info |  | Least severe log line written to standard output (one JSON object per line). |
| `XO_METRICS_TOKEN` (secret) | string |  |  | Bearer token a metrics scraper sends to GET /metrics. Unset: /metrics is off. |
| `XO_CONFIG_FILE` | path |  |  | A KEY=VALUE settings file read at start-up (environment variables win). Default: xo.env in the data directory. |

## Read by the command-line tools

`XO_HOME`, `XO_TOKEN_FILE`, `XO_SERVER_TOKEN`, `XO_WEBHOOK_SECRET`, `XO_WEBHOOK_TLS_CERT`, `XO_WEBHOOK_TLS_KEY`, `XO_WEBHOOK_BEHIND_TLS_PROXY`, `XO_APPROVAL_URL`, `XO_APPROVAL_SECRET`, `XO_DELIVERY_URL`, `XO_DELIVERY_SECRET`, `XO_ANCHOR_URL`, `XO_ANCHOR_SECRET`, `XO_PROVIDER`, `XO_MODEL`, `XO_PROVIDER_BASE_URL`, `XO_EXTRACTOR_PROVIDER`, `XO_EXTRACTOR_MODEL`, `XO_EXTRACTOR_BASE_URL`, `XO_ALLOW_CUSTOM_ENDPOINT`, `XO_CONFIG_DIR`, `XO_GEMINI_THINKING_BUDGET`, `XO_INFERENCE_ALLOW_UNDECLARED`, `XO_SANDBOX_NETWORK`, `XO_DB_URL`, `XO_OIDC_ISSUER`, `XO_OIDC_CLIENT_ID`, `XO_API_URL`. The instance knows these names and does not report them as unknown.
