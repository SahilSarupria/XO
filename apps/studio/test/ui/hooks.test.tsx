import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { loadedValue, useLoad } from '../../src/ui/primitives';
import { useGuardedAction } from '../../src/ui/actions';
import type { Result } from '../../src/platform/client';

const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const bad = <T,>(): Result<T> => ({ ok: false, problem: { kind: 'server', status: 500, message: 'down' } });

describe('useLoad', () => {
  it('keeps the last good value when a REFRESH of the same inputs fails', async () => {
    let n = 0;
    const { result } = renderHook(() => useLoad(async () => (++n === 1 ? ok(['a']) : bad<string[]>()), ['x']));
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect(loadedValue(result.current.state)).toEqual(['a']);
  });

  it('never carries a value across a change of inputs: a value for another analysis must not stand in for this one', async () => {
    const { result, rerender } = renderHook(({ id }) => useLoad(async () => (id === 'one' ? ok(['for-one']) : bad<string[]>()), [id]), {
      initialProps: { id: 'one' },
    });
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    rerender({ id: 'two' });
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect(loadedValue(result.current.state)).toBeUndefined();
  });

  it('ignores a response that arrives after its inputs changed', async () => {
    let release!: (r: Result<string>) => void;
    const slow = new Promise<Result<string>>((res) => (release = res));
    const { result, rerender } = renderHook(({ id }) => useLoad(() => (id === 'old' ? slow : Promise.resolve(ok('new'))), [id]), {
      initialProps: { id: 'old' },
    });
    rerender({ id: 'new' });
    await waitFor(() => expect(loadedValue(result.current.state)).toBe('new'));
    await act(async () => release(ok('old')));
    expect(loadedValue(result.current.state)).toBe('new');
  });
});

describe('useGuardedAction', () => {
  it('runs one action at a time, even for two calls in the same tick', async () => {
    const fn = vi.fn(async () => undefined);
    const { result } = renderHook(() => useGuardedAction());
    await act(async () => {
      void result.current.run(fn);
      void result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('settles only after a confirmed success, and never after a failure', async () => {
    const { result } = renderHook(() => useGuardedAction(30));
    await act(async () => result.current.run(async () => ({ settle: true })));
    expect(result.current.settling).toBe(true);
    await waitFor(() => expect(result.current.settling).toBe(false));
    await act(async () => result.current.run(async () => undefined));
    expect(result.current.settling).toBe(false);
  });

  it('does not touch state after unmount and clears its timer', async () => {
    const spy = vi.spyOn(globalThis, 'clearTimeout');
    const { result, unmount } = renderHook(() => useGuardedAction(10_000));
    await act(async () => result.current.run(async () => ({ settle: true })));
    unmount();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
