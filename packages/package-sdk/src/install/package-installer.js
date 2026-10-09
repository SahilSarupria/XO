import { err, ok } from '@xo/types';
import { ErrorCode, InstallError, PackageError } from '@xo/errors';
import { fingerprintManifest } from '../hashing/fingerprint.js';
import { classifyBump } from '../manifest/semver.js';
import { PackageValidator } from '../validation/package-validator.js';
import { isXoManifest } from '../validation/schema.js';
import { SystemClock } from './clock.js';
const INDEX_KEY = '_index.json';
function packagePrefix(name, version) {
    return `${name}/${version}`;
}
function recordKey(name, version) {
    return `_records/${name}@${version}.json`;
}
/**
 * Installs, removes, upgrades, and inspects XO packages against an
 * injected {@link BlobStore}. This is local install-state management only
 * — fetching a package *from* a marketplace/registry is explicitly out of
 * scope ("Support future registry integration but DO NOT implement the
 * registry"); callers are expected to already have a validated
 * {@link PackageBundle} (e.g. from `unpackArchive`) in hand.
 */
export class PackageInstaller {
    store;
    validator;
    clock;
    constructor(store, options = {}) {
        this.store = store;
        this.validator = options.validator ?? new PackageValidator();
        this.clock = options.clock ?? new SystemClock();
    }
    async readIndex() {
        const raw = await this.store.get(INDEX_KEY);
        if (!raw.ok)
            return { active: {} };
        try {
            return JSON.parse(new TextDecoder().decode(raw.value));
        }
        catch {
            return { active: {} };
        }
    }
    async writeIndex(index) {
        await this.store.put(INDEX_KEY, JSON.stringify(index, null, 2), { contentType: 'application/json' });
    }
    async install(bundle, options = {}) {
        const { name, version } = bundle.manifest;
        if (!options.skipValidation) {
            const report = this.validator.validateAll(bundle);
            if (!report.valid) {
                return err(new InstallError(ErrorCode.PACKAGE_VALIDATION_FAILED, `Refusing to install "${name}@${version}": ${report.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')}`));
            }
        }
        const alreadyInstalled = await this.store.has(recordKey(name, version));
        if (alreadyInstalled && !options.force) {
            return err(new InstallError(ErrorCode.PACKAGE_ALREADY_INSTALLED, `"${name}@${version}" is already installed`));
        }
        const prefix = packagePrefix(name, version);
        const putResults = await Promise.all([
            this.store.put(`${prefix}/manifest.json`, JSON.stringify(bundle.manifest, null, 2), { contentType: 'application/json' }),
            this.store.put(`${prefix}/metadata.json`, bundle.ancillary.metadataJson, { contentType: 'application/json' }),
            ...bundle.components.map((c) => this.store.put(`${prefix}/${c.path}`, c.data)),
        ]);
        const failed = putResults.find((r) => !r.ok);
        if (failed && !failed.ok) {
            return err(new InstallError(ErrorCode.PACKAGE_VALIDATION_FAILED, `Failed to write component(s) for "${name}@${version}"`, { cause: failed.error }));
        }
        const record = {
            name,
            version,
            installedAt: this.clock.now().toISOString(),
            manifestHash: fingerprintManifest(bundle.manifest),
            componentPaths: bundle.components.map((c) => `${prefix}/${c.path}`),
        };
        await this.store.put(recordKey(name, version), JSON.stringify(record, null, 2), { contentType: 'application/json' });
        const index = await this.readIndex();
        await this.writeIndex({ active: { ...index.active, [name]: version } });
        return ok(record);
    }
    async uninstall(name, version) {
        const key = recordKey(name, version);
        const recordRaw = await this.store.get(key);
        if (!recordRaw.ok) {
            return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}" is not installed`));
        }
        const record = JSON.parse(new TextDecoder().decode(recordRaw.value));
        for (const path of record.componentPaths)
            await this.store.delete(path);
        await this.store.delete(`${packagePrefix(name, version)}/manifest.json`);
        await this.store.delete(`${packagePrefix(name, version)}/metadata.json`);
        await this.store.delete(key);
        const index = await this.readIndex();
        if (index.active[name] === version) {
            const { [name]: _removed, ...rest } = index.active;
            await this.writeIndex({ active: rest });
        }
        return ok(undefined);
    }
    /**
     * Installs `bundle` as a new version of an already-installed package,
     * refusing (`PACKAGE_UPGRADE_INVALID`) unless its version is strictly
     * greater than the currently active one. The prior version's files are
     * left in place rather than deleted, so {@link rollback} can re-point
     * the active version back to it without a reinstall.
     */
    async upgrade(bundle, options = {}) {
        const { name, version } = bundle.manifest;
        const index = await this.readIndex();
        const currentVersion = index.active[name];
        if (!currentVersion) {
            return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `Cannot upgrade "${name}": no version is currently installed`));
        }
        const bump = classifyBump(currentVersion, version);
        if (bump === 'invalid' || bump === 'none') {
            return err(new InstallError(ErrorCode.PACKAGE_UPGRADE_INVALID, `"${version}" is not a valid upgrade from the installed "${currentVersion}"`));
        }
        return this.install(bundle, { ...options, force: true });
    }
    /** Re-points the active version pointer to an already-installed (but no longer active) version — the rollback counterpart to {@link upgrade}. Fails if that version's files were previously removed via `uninstall`. */
    async rollback(name, toVersion) {
        const has = await this.store.has(recordKey(name, toVersion));
        if (!has) {
            return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `Cannot roll back "${name}" to "${toVersion}": that version's files are not present (was it uninstalled?)`));
        }
        const index = await this.readIndex();
        await this.writeIndex({ active: { ...index.active, [name]: toVersion } });
        return ok(undefined);
    }
    /**
     * Every installed record for `name`, across all installed versions —
     * unlike {@link listInstalled}, which returns only each package's
     * single currently-*active* version. `@xo/runtime`'s package loader
     * needs this: Runtime Stage 1 mounts whatever versions are actually on
     * disk (SPECIFICATION.md's "support multiple versions simultaneously"),
     * independent of which one this SDK's own active-version pointer
     * happens to point at.
     */
    async listAllInstalledRecords() {
        const keys = await this.store.list('_records/');
        if (!keys.ok)
            return [];
        const records = [];
        for (const key of keys.value) {
            const raw = await this.store.get(key);
            if (raw.ok)
                records.push(JSON.parse(new TextDecoder().decode(raw.value)));
        }
        return records;
    }
    /**
     * Reads and structurally validates the manifest for a specific
     * installed `name@version` — including non-active versions, unlike
     * {@link verifyInstallation} (which re-hashes everything but doesn't
     * return the manifest) or any bundle-shaped method (which requires
     * component bytes the caller may not need just to mount a package).
     */
    async getManifest(name, version) {
        const raw = await this.store.get(`${packagePrefix(name, version)}/manifest.json`);
        if (!raw.ok) {
            return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}" is not installed`));
        }
        let parsed;
        try {
            parsed = JSON.parse(new TextDecoder().decode(raw.value));
        }
        catch (cause) {
            return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, `Installed manifest for "${name}@${version}" is not valid JSON`, { cause }));
        }
        if (!isXoManifest(parsed)) {
            return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, `Installed manifest for "${name}@${version}" does not match the XoManifest shape`));
        }
        return ok(parsed);
    }
    /**
     * Reads one component's raw bytes for a specific installed version —
     * `@xo/runtime`'s knowledge retrieval (Stage 2) needs actual component
     * content (e.g. a `knowledge_graph`'s JSON), not just the manifest's
     * path/hash record of it. Not hash-verified here; call
     * {@link verifyInstallation} first if that matters for the caller —
     * this method optimizes for the common "already-mounted, already
     * verified, now fetch content" path without paying a re-hash per
     * component read.
     */
    async getComponent(name, version, kind) {
        const manifestResult = await this.getManifest(name, version);
        if (!manifestResult.ok)
            return manifestResult;
        const entry = manifestResult.value.components[kind];
        if (!entry) {
            return err(new PackageError(ErrorCode.PACKAGE_COMPONENT_MISSING, `"${name}@${version}" does not declare a "${kind}" component`));
        }
        const raw = await this.store.get(`${packagePrefix(name, version)}/${entry.path}`);
        if (!raw.ok) {
            return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}"'s "${kind}" component is not present in storage`));
        }
        return ok(raw.value);
    }
    async listInstalled() {
        const index = await this.readIndex();
        const records = [];
        for (const [name, version] of Object.entries(index.active)) {
            const raw = await this.store.get(recordKey(name, version));
            if (raw.ok)
                records.push(JSON.parse(new TextDecoder().decode(raw.value)));
        }
        return records;
    }
    /** Re-hashes every installed file for `name@version` against its recorded manifest — detects on-disk corruption or tampering after install, distinct from `PackageValidator` validating a bundle before install. */
    async verifyInstallation(name, version) {
        const manifestRaw = await this.store.get(`${packagePrefix(name, version)}/manifest.json`);
        if (!manifestRaw.ok) {
            return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}" is not installed`));
        }
        const manifest = JSON.parse(new TextDecoder().decode(manifestRaw.value));
        const metadataRaw = await this.store.get(`${packagePrefix(name, version)}/metadata.json`);
        const issues = [];
        const components = [];
        for (const [kind, entry] of Object.entries(manifest.components)) {
            const data = await this.store.get(`${packagePrefix(name, version)}/${entry.path}`);
            if (!data.ok) {
                if (entry.required)
                    issues.push({ severity: 'error', code: 'INSTALLED_COMPONENT_MISSING', message: `"${entry.path}" is missing from the install`, path: entry.path });
                continue;
            }
            components.push({ kind: kind, path: entry.path, data: data.value, required: entry.required });
        }
        const bundle = {
            manifest,
            components,
            ancillary: { metadataJson: metadataRaw.ok ? metadataRaw.value : new Uint8Array() },
        };
        const report = this.validator.validateAll(bundle);
        return ok({ valid: report.valid && issues.length === 0, issues: [...issues, ...report.issues] });
    }
    /**
     * Reinstalls `name@version` from `sourceBundle` — a caller-supplied
     * known-good copy (e.g. re-fetched from wherever the original archive
     * came from), since this SDK has no registry integration to fetch a
     * replacement from itself. Intended to follow a failed
     * `verifyInstallation()`.
     */
    async repairInstallation(sourceBundle) {
        return this.install(sourceBundle, { force: true });
    }
}
//# sourceMappingURL=package-installer.js.map