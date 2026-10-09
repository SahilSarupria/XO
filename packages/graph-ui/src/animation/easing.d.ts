export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
export type EasingFn = (t: number) => number;
/** Pure, deterministic easing functions — inputs/outputs are both in [0, 1]. */
export declare const Easings: Readonly<Record<Easing, EasingFn>>;
//# sourceMappingURL=easing.d.ts.map