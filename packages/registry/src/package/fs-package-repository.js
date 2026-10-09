import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, RegistryError } from '@xo/errors';
import { isXoManifest } from '@xo/package-sdk';
function stripScheme(hash) {
    return hash.replace(/^sha256:/, '');
}
function recordKey(id) {
    return `packages/records/${stripScheme(id)}.json`;
}
function creatorIndexKey(creatorDid, id) {
    return `packages/by-creator/${encodeURIComponent(creatorDid)}/${stripScheme(id)}.json`;
}
/**
 * Local-filesystem `PackageRepository`, content-addressed by the
 * manifest's own `merkleRoot` (per the task brief: "content-addressed by
 * the package's existing Merkle root rather than inventing a new ID
 * scheme") rather than an incrementing counter or a random UUID a caller
 * could collide with independently of package content.
 *
 * **Verification boundary.** `PackageRepository.publish()` is a frozen
 * interface that only receives a `PackageRecord` (`id` + `manifest` +
 * `publishedAt`) — it never sees component bytes, so it cannot itself run
 * `PackageValidator.validateAll()`, which needs a full `PackageBundle` to
 * check component hashes and the Merkle root against real data. This
 * repository still refuses anything it *can* check from the manifest
 * alone (schema shape, a `merkleRoot` that's actually present, and that
 * the caller isn't lying about `id` not matching `manifest.merkleRoot`)
 * as defense-in-depth, but the authoritative hash/Merkle/signature
 * verification — "never trust an unverified manifest" — happens one
 * layer up, in `RegistryClient.publish()`, which *does* receive the full
 * `PackageBundle` and runs `PackageValidator.validateAll()` on it before
 * ever constructing the `PackageRecord` this method is handed. See this
 * package's README, "Why verification happens in `RegistryClient`, not
 * here", for the full reasoning.
 */
export class FsPackageRepository {
    store;
    constructor(store) {
        this.store = store;
    }
    async publish(record) {
        if (!isXoManifest(record.manifest)) {
            return err(new RegistryError(ErrorCode.REGISTRY_PACKAGE_UNVERIFIED, `Package "${record.id}" was not published: its manifest does not match the XoManifest schema`));
        }
        if (!record.manifest.merkleRoot) {
            return err(new RegistryError(ErrorCode.REGISTRY_PACKAGE_UNVERIFIED, `Package "${record.id}" was not published: its manifest has no merkleRoot to content-address it by`));
        }
        if (record.manifest.merkleRoot !== record.id) {
            return err(new RegistryError(ErrorCode.REGISTRY_PACKAGE_UNVERIFIED, `Package record id "${record.id}" does not match its own manifest.merkleRoot "${record.manifest.merkleRoot}" — a PackageRecord's id must be its manifest's merkleRoot`));
        }
        if (await this.store.has(recordKey(record.id))) {
            return err(new RegistryError(ErrorCode.REGISTRY_PACKAGE_ALREADY_PUBLISHED, `Package "${record.id}" is already published (publish is content-addressed and idempotent-by-rejection, not by overwrite)`));
        }
        const payload = JSON.stringify(record);
        const putRecord = await this.store.put(recordKey(record.id), payload);
        if (!putRecord.ok)
            return err(putRecord.error);
        // Best-effort secondary index for listByCreator — see the README's
        // "Known limitations" for why this isn't transactional with the
        // primary write above (LocalFsBlobStore has no multi-key transaction
        // primitive to make it so).
        const putIndex = await this.store.put(creatorIndexKey(record.manifest.creatorDid, record.id), payload);
        if (!putIndex.ok)
            return err(putIndex.error);
        return ok(undefined);
    }
    async get(id) {
        const raw = await this.store.get(recordKey(id));
        if (!raw.ok)
            return err(new NotFoundError(`Package "${id}"`));
        try {
            return ok(JSON.parse(new TextDecoder().decode(raw.value)));
        }
        catch {
            return err(new NotFoundError(`Package "${id}" (stored record is corrupt)`));
        }
    }
    async listByCreator(creatorDid) {
        const listed = await this.store.list(`packages/by-creator/${encodeURIComponent(creatorDid)}/`);
        if (!listed.ok)
            return [];
        const records = [];
        for (const key of listed.value) {
            const raw = await this.store.get(key);
            if (!raw.ok)
                continue;
            try {
                records.push(JSON.parse(new TextDecoder().decode(raw.value)));
            }
            catch {
                // Skip a corrupt index entry rather than failing the whole listing.
            }
        }
        return records;
    }
    /**
     * Lists every published package, regardless of creator. Not part of
     * `PackageRepository` — that frozen interface only offers
     * `listByCreator`, deliberately (it's a per-creator registry API, not
     * a full-catalog browse). `RegistryClient.search()` needs "every
     * package" as its starting point, so this is exposed as an extra
     * method on the concrete implementation rather than smuggled into the
     * interface.
     */
    async listAll() {
        const listed = await this.store.list('packages/records/');
        if (!listed.ok)
            return [];
        const records = [];
        for (const key of listed.value) {
            const raw = await this.store.get(key);
            if (!raw.ok)
                continue;
            try {
                records.push(JSON.parse(new TextDecoder().decode(raw.value)));
            }
            catch {
                // Skip a corrupt record rather than failing the whole listing.
            }
        }
        return records;
    }
}
//# sourceMappingURL=fs-package-repository.js.map