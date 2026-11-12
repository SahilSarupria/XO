# @xo/connect: architecture (C7)

Studio (presentation) -> **@xo/connect** (this package) -> Environment Intelligence C1-C5 (and C6 for knowledge, from C7.3).

## Ownership boundaries

| Concern                                                                                                        | Owner                                                   |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| What a user sees and can do in the Connect journey; state vocabulary; wording-relevant facts (`ActionEffects`) | `@xo/connect` (`contract.ts`, `state.ts`, `service.ts`) |
| Authentication, authorization, audit, scope enforcement, reading                                               | EI (reached only through `LocalFolderBackend`)          |
| Retrieval, provenance, visibility (C7.3)                                                                       | C6 SDK. Connect must not reimplement them               |
| Presentation, copy, layout, "Sample data" labels                                                               | Studio. Sample data is never produced by this package   |
| HTTP transport and principal establishment                                                                     | `apps/api` (`connect-routes.ts`: thin delegation)       |

`@xo/connect` imports no Studio, React or HTTP code. Its only backend dependency is the `LocalFolderBackend` port; `createEiLocalFolderBackend` is the adapter over EI's `discoverSource` / `acquireSourceContent`. The host's composition root supplies the registry, inventory and a `contextFor(principal)` that carries the platform authorization port, audit recorder, ledger and state. Connect never builds those, so it cannot weaken them.

## Security properties (each has a test)

- Every operation requires a genuine `AuthenticatedPrincipal` (`isAuthenticatedPrincipal`); plain objects are refused.
- A principal addresses only its own sources (`ownerId/sourceId` key). Another principal gets `not_found`.
- Input is validated before the backend is touched: absolute root without `..`/NUL; item keys relative with no empty/`.`/`..` segments, bounded counts and lengths; names without separators.
- Selection is enforced in the backend path: only chosen, currently-present, content-acquirable, non-excluded keys reach `read`; exclusion by name wins; chunked to the connector's per-call limit. EI independently refuses escaping keys (tested at the backend, bypassing Connect validation).
- `disconnect` is enforced in `readNow`, not only in a UI.
- Fail closed: authorization denial, an unavailable state store, or a corrupt state file yields an error, never a healthy-looking state. A corrupt state file is an error, never "empty".
- No path, file name or content is returned in errors or history. Cards expose the folder's last segment only.

## State derivation

`deriveState` is pure. The platform `acquisition` axis also becomes `succeeded` after a _listing_, so it cannot prove content was read; "read complete/partial" therefore comes from Connect's own recorded read. Found by the integration test.
`access_ended` never says expired vs revoked, and never says knowledge was removed.

## Not in this package yet

Knowledge (C7.3), review/retention (C7.4), cloud (C7.5).
