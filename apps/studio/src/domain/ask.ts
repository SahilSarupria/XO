import type { AskPlace } from '../platform/wire-ask';
import type { Section } from '../ui/sectionRoute';

/**
 * S1-3b — small, pure helpers for the Ask box: what it says in the bar on each screen, and where a "navigate" answer goes.
 */

/** The bar's placeholder: it names where the person is, and promises only what the Ask route does. */
export function askPlaceholder(place: AskPlace, workflowName?: string): string {
  if (workflowName !== undefined) return `Ask about “${workflowName.length > 40 ? `${workflowName.slice(0, 39)}…` : workflowName}”…`;
  switch (place) {
    case 'home':
      return 'Ask XO, analyse a document, or start a workflow…';
    case 'inbox':
      return 'Ask about what is waiting for you…';
    case 'work':
      return 'Ask about your workflows, or start one…';
    case 'sources':
      return 'Ask about your sources, or drop a document to read…';
    case 'knowledge':
      return 'Ask what XO knows…';
    case 'activity':
      return 'Ask about runs, or open one…';
    case 'settings':
      return 'Ask XO…';
  }
}

/** The screen each place opens on. */
export const PLACE_SECTION: Readonly<Record<AskPlace, Section>> = {
  home: 'home',
  inbox: 'tasks',
  work: 'work',
  sources: 'setup',
  knowledge: 'whatxoknows',
  activity: 'activity',
  settings: 'settings',
};
