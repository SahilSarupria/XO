import { scopeKey } from './scope.js';
export function computeGrantId(packageId, permission, scope) {
    return `${packageId}::${permission}::${scopeKey(scope)}`;
}
//# sourceMappingURL=grant.js.map