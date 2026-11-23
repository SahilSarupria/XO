// The one place the visual-regression thresholds, viewports and pinned versions live.
// Anything here that changes what counts as "a visual regression" must also change docs/studio/VISUAL_REGRESSION.md.

/** Must equal the exact `playwright` version in package.json AND the tag of the container image in the workflow. */
export const EXPECTED_PLAYWRIGHT_VERSION = '1.56.1';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
};

/**
 * Comparison rules (documented in docs/studio/VISUAL_REGRESSION.md):
 *  - a pixel "differs" when any colour channel (R, G, B, A) is more than CHANNEL_TOLERANCE away from the reference;
 *  - a screen FAILS when more than MAX_DIFF_PIXELS pixels differ, or when its dimensions changed.
 * The tolerance absorbs sub-pixel anti-aliasing noise; the pixel budget is far below one changed word of text.
 */
export const CHANNEL_TOLERANCE = 8;
export const MAX_DIFF_PIXELS = 50;

export const TIMEOUTS = {
  /** Each service must answer within this long or the run is an infrastructure failure. */
  serviceStartMs: 90_000,
  /** Each expected piece of UI must appear within this long. */
  uiMs: 20_000,
};

export const EXIT = { pass: 0, regression: 10, infra: 20 };

/**
 * The fixed words used to create synthetic data (S1-2: the V1 shape, kept industry-neutral). Nothing here is a real person,
 * organisation or credential; the addresses use the reserved example domains.
 */
export const SYNTHETIC = {
  workspaceName: 'Client operations',
  emptyWorkspaceName: 'Operations',
  operatorIdentity: 'journey-operator',
  reviewerIdentity: 'journey-reviewer',
  newcomerIdentity: 'journey-newcomer',
  folderName: 'Clients',
  people: [
    { name: 'Asha Rao', email: 'asha@client.example', file: 'Asha_Rao.pdf' },
    { name: 'Bilal Khan', email: 'bilal@client.example', file: 'bilal-khan.pdf' },
    { name: 'Chen Wei', email: 'chen@client.example', file: 'Document - Chen Wei.pdf' },
    // No document yet: XO leaves this person out and says so.
    { name: 'Dev Patel', email: 'dev@client.example' },
  ],
  sendProcedure:
    '# Sending documents\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Email the client their document. | The client has their document. | Office manager |\n',
  sendGoal: 'send each client their document',
  sendWorkflowName: 'Send each client their document',
  checkProcedure:
    "# Opening checklist\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Check the overnight messages. | Every message is read. | Office manager |\n| 2 | Confirm the day's appointments. | The list is confirmed. | Office manager |\n",
  checkGoal: 'open the office',
  checkWorkflowName: 'Open the office',
};
