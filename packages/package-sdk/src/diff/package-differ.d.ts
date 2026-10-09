import type { XoManifest } from '@xo/types';
import type { ComponentDiffEntry, ManifestDiff, PackageBundle, PackageDiff, UpgradePlan } from '../types.js';
export declare function compareManifests(from: XoManifest, to: XoManifest): ManifestDiff;
export declare function compareComponents(from: XoManifest, to: XoManifest): readonly ComponentDiffEntry[];
export declare function comparePackages(from: PackageBundle, to: PackageBundle): PackageDiff;
/**
 * Turns a {@link PackageDiff} into an ordered list of {@link UpgradeStep}s
 * plus a `safe` verdict. "Safe" here means: the version actually
 * increases, and no *required* component is being removed outright — an
 * upgrade that drops a required component would leave an installation
 * that can never pass `PackageValidator.validateRequiredComponents`
 * again, which the installer's `upgrade()` doesn't itself check for
 * (it only checks the version bump), so this is the place that catches it.
 */
export declare function generateUpgradePlan(from: PackageBundle, to: PackageBundle): UpgradePlan;
//# sourceMappingURL=package-differ.d.ts.map