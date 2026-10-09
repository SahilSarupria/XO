export { Easings } from './easing.js';
export type { Easing, EasingFn } from './easing.js';

export { lerpNumber, lerpPoint, lerpViewportState } from './lerp.js';

export { GraphAnimation } from './GraphAnimation.js';
export type { AnimationSpec } from './GraphAnimation.js';

export { GraphAnimationEngine } from './GraphAnimationEngine.js';

export {
  animateNodePosition,
  nodePositionAt,
  animateEdgeFlow,
  edgeFlowPhaseAt,
  animateHighlight,
  highlightIntensityAt,
  stopHighlight,
  animateSelectionEnter,
  selectionIntensityAt,
  stopSelectionAnimation,
  animateExecutionActive,
  executionIntensityAt,
  stopExecutionAnimation,
  animateViewportTransition,
  viewportStateAt,
  isViewportTransitionComplete,
  computeExecutionPathReveal,
} from './graphAnimations.js';
export type { ExecutionPathReveal } from './graphAnimations.js';
