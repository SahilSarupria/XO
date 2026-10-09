export interface Captured<T> {
  readonly value?: T;
  readonly thrown?: unknown;
  /** Everything written to stdout and stderr while `fn` ran, interleaved in write order. */
  readonly text: string;
}

type WriteFn = typeof process.stdout.write;

/**
 * Runs `fn` while diverting everything it writes to `process.stdout` /
 * `process.stderr` into a buffer. This is what lets the interactive
 * session wrap every existing command — which all print directly — in a
 * status box without any command being modified. Always restores the
 * real writers, including when `fn` throws.
 */
export async function captureOutput<T>(fn: () => Promise<T> | T): Promise<Captured<T>> {
  const chunks: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;

  const divert = ((chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const done = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (done) done();
    return true;
  }) as WriteFn;

  process.stdout.write = divert;
  process.stderr.write = divert;
  try {
    const value = await fn();
    return { value, text: chunks.join('') };
  } catch (thrown) {
    return { thrown, text: chunks.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}
