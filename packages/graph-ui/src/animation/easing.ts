export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
export type EasingFn = (t: number) => number;

/** Pure, deterministic easing functions — inputs/outputs are both in [0, 1]. */
export const Easings: Readonly<Record<Easing, EasingFn>> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};
