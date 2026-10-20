import { useCallback, useEffect, useState } from 'react';

// Comment-only change to check that a push touching apps/studio/** starts the visual-regression workflow. No behaviour change.
export const SECTIONS = [
  'home',
  'chat',
  'graph',
  'executions',
  'create',
  'xo',
  'workspaces',
  'work',
  'tasks',
  'activity',
  'setup',
  'processes',
  'contracts',
  'platform',
  'library',
  'audit',
  'settings',
] as const;
export type Section = (typeof SECTIONS)[number];

/** Screens that only exist in Builder mode. Which section a Builder-only screen falls back to in User mode. */
export const BUILDER_SECTIONS: Readonly<Partial<Record<Section, Section>>> = {
  processes: 'work',
  contracts: 'setup',
  platform: 'home',
};
export const isBuilderSection = (s: Section): boolean => s in BUILDER_SECTIONS;

/** `#/work` -> 'work'. Anything unrecognised is 'home'; the hash never grants anything, it only selects a screen. */
export function parseSection(hash: string): Section {
  const name = hash.replace(/^#\/?/, '');
  return (SECTIONS as readonly string[]).includes(name) ? (name as Section) : 'home';
}

/**
 * The current section lives in the URL fragment so refresh, Back/Forward and copied links keep the
 * person's place. Presentation only: no data, identity or authority is read from or written to the URL.
 */
export function useSectionRoute(): [Section, (s: Section) => void, (s: Section) => void] {
  const [section, setSection] = useState<Section>(() => parseSection(window.location.hash));
  useEffect(() => {
    const onChange = () => setSection(parseSection(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback((s: Section) => {
    if (parseSection(window.location.hash) === s) return;
    window.location.hash = `/${s}`; // adds a history entry; hashchange updates state
    setSection(s);
  }, []);
  const replace = useCallback((s: Section) => {
    window.history.replaceState(null, '', `#/${s}`);
    setSection(s);
  }, []);
  return [section, go, replace];
}
