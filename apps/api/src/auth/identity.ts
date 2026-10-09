/**
 * The caller identity resolved by API key authentication
 * (`../http/auth.ts`) and attached to `ApiRequest.identity`
 * (`../http/types.ts`). Deliberately minimal — this is the answer to
 * "who is calling", not "what are they allowed to do"; scopes, roles,
 * and grants are `@xo/permissions`' concern, not auth's. See
 * `apps/api/README.md`'s "Auth" section for the full reasoning.
 */
export interface ApiKeyIdentity {
  /**
   * The internal identity id the key was issued to (see
   * `ApiKeyRecord.identityId`, `api-key-store.interface.ts`). Opaque —
   * not a DID, not necessarily tied to any package-publishing identity.
   */
  readonly identityId: string;

  /**
   * Present only when this API key was issued to (or explicitly
   * associated with) a package-publishing identity compatible with
   * `@xo/registry-core`'s `creatorDid` concept
   * (`PackageRepository.listByCreator`, `SPECIFICATION.md` §1.2's
   * `creator.id`). Most API keys — a CI script calling
   * `/runtime/execute`, a monitoring job hitting `/registry/search` —
   * have no publishing identity at all and this stays unset. See
   * `apps/api/README.md`'s "API key identity vs. creatorDid" section.
   */
  readonly creatorDid?: string;
}
