const noopSpan = {
    setAttribute: () => { },
    recordException: () => { },
    setStatus: () => { },
    end: () => { },
};
export const noopTracer = {
    startSpan: () => noopSpan,
    withSpan: async (_name, fn) => fn(noopSpan),
};
const noopCounter = { add: () => { } };
const noopHistogram = { record: () => { } };
export const noopMeter = {
    createCounter: () => noopCounter,
    createHistogram: () => noopHistogram,
};
//# sourceMappingURL=noop.js.map