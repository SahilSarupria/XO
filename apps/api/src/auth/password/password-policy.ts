/**
 * Password and login-name rules, following NIST SP 800-63B: length, not composition. Everything here runs BEFORE any
 * hashing so an oversized or trivial input never reaches the expensive path.
 *
 *  - 12 to 128 characters and at most 1024 UTF-8 bytes; any printable Unicode including spaces.
 *  - NFKC-normalized first, so the same visible password is always the same bytes.
 *  - No "must contain a digit" rules and no expiry (both are counter-productive per NIST).
 *  - Rejected: a short bundled list of very common long passwords, one containing the login name, one made of a
 *    single repeated character, and trivial sequences. The bundled list is a floor, not a breach corpus — there is
 *    deliberately no online breach check (it needs outbound network, which air-gapped mode forbids).
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_PASSWORD_BYTES = 1024;

const COMMON = new Set(
  [
    'passwordpassword',
    'password1234',
    'password12345',
    'password123456',
    'password1234567',
    'passw0rd1234',
    'letmein12345',
    'letmeinletmein',
    'qwertyuiop12',
    'qwertyuiop123',
    'qwertyuiopas',
    'qwertyuiopasdf',
    'qwerty123456',
    'qwerty1234567',
    'asdfghjkl123',
    'asdfghjklqwe',
    'zxcvbnm12345',
    '123456789012',
    '1234567890123',
    '12345678901234',
    '123456789abc',
    '1q2w3e4r5t6y',
    '1qaz2wsx3edc',
    'abcdefghijkl',
    'abcdefghijklmn',
    'abcd12345678',
    'iloveyou1234',
    'iloveyouiloveyou',
    'welcome12345',
    'welcomewelcome',
    'administrator',
    'administrator1',
    'adminadminadmin',
    'admin1234567',
    'changeme1234',
    'changemechangeme',
    'trustno1trustno1',
    'monkey123456',
    'dragon123456',
    'football1234',
    'baseball1234',
    'sunshine1234',
    'princess1234',
    'superman1234',
    'masterkey1234',
    'whatever12345',
    'starwars1234',
    'internet1234',
    'computer1234',
    'michael12345',
    'charlie12345',
    'summer2024!!',
    'winter2024!!',
  ].map((p) => p.toLowerCase()),
);

export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export function normalizeLoginName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

/** A login name an operator may create: 3-120 characters, no control characters or whitespace inside. */
export function loginNameProblem(normalized: string): string | undefined {
  if (normalized.length < 3 || normalized.length > 120) return 'a login name must be 3 to 120 characters';

  if (/[\u0000-\u001f\u007f\s]/.test(normalized)) return 'a login name must not contain spaces or control characters';
  return undefined;
}

function isTrivial(p: string): boolean {
  if (/^(.)\1+$/u.test(p)) return true; // one character repeated
  const chars = [...p];
  const steps = chars.slice(1).map((c, i) => (c.codePointAt(0) ?? 0) - (chars[i]?.codePointAt(0) ?? 0));
  return steps.every((d) => d === 1) || steps.every((d) => d === -1); // abcdefghijkl / 987654321098 style runs
}

/**
 * `undefined` when acceptable, otherwise a message that names the RULE broken. It never echoes the password. Callers
 * pass the NORMALIZED login name (or `undefined` when there is none yet).
 */
export function passwordProblem(password: string, normalizedLoginName?: string): string | undefined {
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return `a password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const p = normalizePassword(password);
  const length = [...p].length;
  if (length < MIN_PASSWORD_LENGTH) return `a password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (length > MAX_PASSWORD_LENGTH) return `a password must be at most ${MAX_PASSWORD_LENGTH} characters`;

  if (/[\u0000-\u001f\u007f]/.test(p)) return 'a password must not contain control characters';
  const lower = p.toLowerCase();
  if (COMMON.has(lower.replace(/\s+/g, ''))) return 'that password is too common; choose a different one';
  if (isTrivial(lower)) return 'that password is too predictable (a repeated character or a simple sequence)';
  if (normalizedLoginName !== undefined && normalizedLoginName.length >= 3 && lower.includes(normalizedLoginName)) {
    return 'a password must not contain your login name';
  }
  return undefined;
}
