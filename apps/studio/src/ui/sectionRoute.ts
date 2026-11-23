import { useCallback, useEffect, useState } from 'react';

/**
 * S1-3 (plan 3, 6.1): Studio's addresses are real paths, so a link can be shared, opened in a new tab, kept through sign-in and
 * sent in a notification: `/w/<workspace>/<place>[/<view>]`. The path only selects a screen; it never grants anything, and an
 * unknown path is Home. Old `#/section` links still work: they are replaced by their path on arrival.
 */
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
  'connect',
  'knowledge',
  'whatxoknows',
  'audit',
  'settings',
] as const;
export type Section = (typeof SECTIONS)[number];

/** Screens that only exist in Builder mode, and the screen each falls back to in User mode. */
export const BUILDER_SECTIONS: Readonly<Partial<Record<Section, Section>>> = {
  processes: 'work',
  contracts: 'setup',
  platform: 'settings',
};
export const isBuilderSection = (s: Section): boolean => s in BUILDER_SECTIONS;

/** Each screen's path under `/w/<workspace>`, grouped by the seven places (Home, Inbox, Work, Sources, Knowledge, Activity, Settings). */
export const SECTION_PATH: Readonly<Record<Section, string>> = {
  home: 'home',
  chat: 'ask',
  tasks: 'inbox',
  work: 'work',
  library: 'work/library',
  graph: 'work/graph',
  executions: 'work/runs',
  processes: 'work/processes',
  setup: 'sources',
  connect: 'sources/connections',
  create: 'sources/new',
  xo: 'sources/xo',
  contracts: 'sources/contracts',
  whatxoknows: 'knowledge',
  knowledge: 'knowledge/search',
  activity: 'activity',
  audit: 'activity/audit',
  settings: 'settings',
  workspaces: 'settings/workspaces',
  platform: 'settings/platform',
};
const BY_PATH = new Map(Object.entries(SECTION_PATH).map(([s, p]) => [p, s as Section]));

/** The workspace id in a path, if there is one (`/w/<id>/…`). */
export function workspaceInPath(pathname: string): string | undefined {
  const m = /^\/w\/([^/]+)/.exec(pathname);
  if (m === null) return undefined;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
}

/** The screen a location shows: the path when it names one, else an old `#/section` link, else Home. */
export function sectionOf(loc: { readonly pathname: string; readonly hash: string }): Section {
  const m = /^\/w\/[^/]+\/(.*?)\/?$/.exec(loc.pathname);
  if (m !== null) return BY_PATH.get(m[1]!) ?? 'home';
  const legacy = loc.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (SECTIONS as readonly string[]).includes(legacy) ? (legacy as Section) : 'home';
}

/** @deprecated kept for old callers: the screen an old `#/section` fragment names. */
export function parseSection(hash: string): Section {
  return sectionOf({ pathname: '/', hash });
}

export function pathOf(section: Section, workspaceId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/${SECTION_PATH[section]}`;
}

/**
 * The current screen, kept in the address bar so refresh, Back/Forward and copied links keep the person's place. On arrival, an
 * old `#/section` link or a bare `/` is replaced by this workspace's path. Presentation only.
 */
export function useSectionRoute(workspaceId: string): [Section, (s: Section) => void, (s: Section) => void] {
  const [section, setSection] = useState<Section>(() => sectionOf(window.location));
  useEffect(() => {
    const want = pathOf(sectionOf(window.location), workspaceId);
    if (window.location.pathname !== want || window.location.hash !== '')
      window.history.replaceState(window.history.state, '', `${want}${window.location.search}`);
    const onPop = () => setSection(sectionOf(window.location));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [workspaceId]);
  const go = useCallback(
    (s: Section) => {
      const to = pathOf(s, workspaceId);
      if (window.location.pathname !== to) window.history.pushState(null, '', to);
      setSection(s);
    },
    [workspaceId],
  );
  const replace = useCallback(
    (s: Section) => {
      window.history.replaceState(null, '', pathOf(s, workspaceId));
      setSection(s);
    },
    [workspaceId],
  );
  return [section, go, replace];
}
