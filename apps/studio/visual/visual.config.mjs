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

/** The fixed words used to create synthetic data. Nothing here is a real person, organisation or credential. */
export const SYNTHETIC = {
  workspaceName: 'Commercial property claims',
  emptyWorkspaceName: 'Visual baseline workspace',
  demoIdentity: 'visual-demo',
  emptyIdentity: 'visual-empty',
  fixturePdf: 'examples/vertical-test/Aastha.pdf',
};
