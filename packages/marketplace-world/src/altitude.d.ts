import { AltitudeModel, type AltitudeLevel } from '@xo/atlas';
/**
 * The marketplace depth model.
 *
 * Not every level implies UI — some are here purely to describe what
 * information *becomes available*, leaving whether or how to render
 * it entirely to the consumer. That's the point of separating this
 * from Atlas's SemanticZoomRegistry (see semantic.ts): this module
 * says *when something exists to know*; semantic.ts says *how visible
 * it currently is*.
 */
export declare const MARKETPLACE_ALTITUDE_LEVELS: readonly AltitudeLevel[];
export declare function createMarketplaceAltitudeModel(): AltitudeModel;
//# sourceMappingURL=altitude.d.ts.map