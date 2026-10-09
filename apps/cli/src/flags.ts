/** Reads a string-valued `--flag`; returns `undefined` for a missing flag or a valueless boolean flag (`--flag` with no following value). */
export function requireFlag(flags: Readonly<Record<string, string | boolean>>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}
