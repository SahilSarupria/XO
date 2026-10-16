/** Sign-in endpoints that take no bearer credential (they establish one). Logout is NOT here: it requires a valid session credential. */
export const SESSION_PUBLIC_PATHS: readonly string[] = ['/auth/login-challenge', '/auth/session', '/auth/refresh'];
