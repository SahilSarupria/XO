// Nothing the suite writes to a log, report or artifact may contain a credential.
// Defence in depth: services get a minimal environment, keys are never printed by our own code, and everything that
// does reach a file passes through this filter as well.
const KEY_SHAPE = /xoak_[A-Za-z0-9_-]+/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export function makeRedactor(secrets = []) {
  const known = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  return (text) => {
    let out = String(text).replace(KEY_SHAPE, 'xoak_[redacted]').replace(BEARER, '$1[redacted]');
    for (const s of known) out = out.split(s).join('[redacted]');
    return out;
  };
}
