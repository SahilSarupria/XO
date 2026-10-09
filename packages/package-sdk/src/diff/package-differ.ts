import type { ComponentKind, XoManifest } from '@xo/types';
import { classifyBump } from '../manifest/semver.js';
import type { ComponentDiffEntry, ManifestDiff, PackageBundle, PackageDiff, UpgradePlan, UpgradeStep } from '../types.js';

export function compareManifests(from: XoManifest, to: XoManifest): ManifestDiff {
  const compatibilityChanged = JSON.stringify(from.compatibility) !== JSON.stringify(to.compatibility);
  return {
    nameChanged: from.name !== to.name,
    fromVersion: from.version,
    toVersion: to.version,
    versionBump: classifyBump(from.version, to.version),
    compatibilityChanged,
  };
}

export function compareComponents(from: XoManifest, to: XoManifest): readonly ComponentDiffEntry[] {
  const kinds = new Set<ComponentKind>([...Object.keys(from.components), ...Object.keys(to.components)] as ComponentKind[]);
  const entries: ComponentDiffEntry[] = [];
  for (const kind of kinds) {
    const fromEntry = from.components[kind];
    const toEntry = to.components[kind];
    if (fromEntry && !toEntry) {
      entries.push({ kind, change: 'removed', fromHash: fromEntry.hash });
    } else if (!fromEntry && toEntry) {
      entries.push({ kind, change: 'added', toHash: toEntry.hash });
    } else if (fromEntry && toEntry) {
      entries.push({
        kind,
        change: fromEntry.hash === toEntry.hash ? 'unchanged' : 'modified',
        fromHash: fromEntry.hash,
        toHash: toEntry.hash,
      });
    }
  }
  return entries.sort((a, b) => a.kind.localeCompare(b.kind));
}

export function comparePackages(from: PackageBundle, to: PackageBundle): PackageDiff {
  return { manifest: compareManifests(from.manifest, to.manifest), components: compareComponents(from.manifest, to.manifest) };
}

/**
 * Turns a {@link PackageDiff} into an ordered list of {@link UpgradeStep}s
 * plus a `safe` verdict. "Safe" here means: the version actually
 * increases, and no *required* component is being removed outright — an
 * upgrade that drops a required component would leave an installation
 * that can never pass `PackageValidator.validateRequiredComponents`
 * again, which the installer's `upgrade()` doesn't itself check for
 * (it only checks the version bump), so this is the place that catches it.
 */
export function generateUpgradePlan(from: PackageBundle, to: PackageBundle): UpgradePlan {
  const diff = comparePackages(from, to);
  const reasons: string[] = [];
  const steps: UpgradeStep[] = [];

  if (diff.manifest.versionBump === 'invalid' || diff.manifest.versionBump === 'none') {
    reasons.push(`"${diff.manifest.toVersion}" is not a valid upgrade from "${diff.manifest.fromVersion}"`);
  }

  for (const entry of diff.components) {
    switch (entry.change) {
      case 'added':
        steps.push({ kind: 'install_component', componentKind: entry.kind, description: `Install new component "${entry.kind}"` });
        break;
      case 'removed': {
        const wasRequired = from.manifest.components[entry.kind]?.required ?? false;
        steps.push({ kind: 'remove_component', componentKind: entry.kind, description: `Remove component "${entry.kind}"` });
        if (wasRequired) reasons.push(`Component "${entry.kind}" is required by the current version and is not present in the upgrade target`);
        break;
      }
      case 'modified':
        steps.push({ kind: 'replace_component', componentKind: entry.kind, description: `Replace component "${entry.kind}" (content changed)` });
        break;
      case 'unchanged':
        break;
    }
  }
  steps.push({ kind: 'update_manifest', description: `Update manifest ${diff.manifest.fromVersion} -> ${diff.manifest.toVersion}` });

  return {
    fromVersion: diff.manifest.fromVersion,
    toVersion: diff.manifest.toVersion,
    steps,
    safe: reasons.length === 0,
    reasons,
  };
}
