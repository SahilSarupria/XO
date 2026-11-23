/**
 * S1-3: this Studio's version, and the API versions it works with. A test keeps STUDIO_VERSION equal to package.json. Studio
 * works with any API whose major.minor equals SUPPORTED_API (semver 0.x: a new minor may change the contract).
 */
export const STUDIO_VERSION = '0.1.0';
export const SUPPORTED_API = '0.1';

/** Whether an API version (as `GET /version` reports it) is one this Studio supports. */
export function supportsApi(version: string): boolean {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  return m !== null && `${m[1]}.${m[2]}` === SUPPORTED_API;
}
