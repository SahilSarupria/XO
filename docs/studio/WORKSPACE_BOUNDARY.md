# Workspace boundary (interface only)

`apps/studio/src/workspace/boundary.ts` defines the typed seam a future IDE will use: workspace metadata, a `WorkspaceProvider` (`list`/`open`), an optional `files` capability, and `parseWorkspaceRelativePath` (strict, portable relative-path contract, tested).

Not implemented, on purpose: any provider, local file access, durable storage, checkpoints, task/agent recovery. Those are **P1.1-D (Durable Workspaces & Agent Recovery)**, still in its accepted position within P1.1. The existing screens use the server-side XO workspace through `platform/client.ts` and do not touch this interface.

Intended implementations: a desktop local-folder provider behind validated native commands scoped to one user-selected folder (native code must re-validate and canonicalize against that root; the TypeScript path check is an input contract, not the enforcement point), and a hosted provider behind the XO API for the web experience. A provider supplies files only; it never grants XO permissions.
