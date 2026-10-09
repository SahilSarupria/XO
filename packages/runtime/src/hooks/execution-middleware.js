/** Composes `middleware` (outermost first) around `core`, the pipeline's actual execution function. */
export function composeMiddleware(middleware, core) {
    return middleware.reduceRight((next, mw) => (request) => mw(request, next), core);
}
//# sourceMappingURL=execution-middleware.js.map