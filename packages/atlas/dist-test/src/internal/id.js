/** Internal, dependency-free id generator. Not exported. */
let counter = 0;
export function nextId(prefix) {
    counter += 1;
    return `${prefix}_${counter.toString(36)}`;
}
//# sourceMappingURL=id.js.map