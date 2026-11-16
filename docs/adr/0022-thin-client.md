# 0022: Thin clients; mobile Studio first as a responsive web client (D-M)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Applies to UW-2, UW-3, UW-8 and UW-12.

## Context

Studio is an HTTP client with no heavy client-side dependencies; there is no mobile shell; `.xlsx` is not in the API upload list
(`docs/baseline/UW0_BASELINE.md` §7 rows 6 and 35). The owner wants a mobile-friendly Studio and, as the eventual primary end-user
interface, a messaging channel.

## Decision

1. Parsing, OCR, matching, detection and token maps stay on the server. Clients render state and send decisions.
2. **Studio remains the native desktop engineering and operating environment** (Tauri with React/TypeScript, owner's master context
   §14). Its React UI is built responsively, so the **same UI** serves phones as a web client for approvals, monitoring and
   notifications. There is one UI codebase and no separate mobile implementation of any platform semantics.
3. Server APIs used by clients are compact and paginated, with change notifications (UW-2), and uploads are resumable (UW-3).
4. A messaging channel is another thin client of the same control API, never a second engine (ADRs 0011, 0013).

## Reopen if

A required capability can only be delivered natively.
