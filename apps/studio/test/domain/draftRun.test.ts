import { describe, expect, it } from 'vitest';
import { mergeInputContracts } from '../../src/domain/draftRun';
import type { Capability } from '../../src/platform/wire';

const cap = (props: Record<string, 'string' | 'number' | 'boolean'>, required: string[]): Capability =>
  ({
    capabilityId: 'c',
    inputContract: { properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])), required },
  }) as unknown as Capability;

describe('mergeInputContracts', () => {
  it('unions properties and required names across steps', () => {
    const m = mergeInputContracts([cap({ a: 'string' }, ['a']), cap({ b: 'number', a: 'string' }, ['b'])]);
    expect(Object.keys(m!.properties).sort()).toEqual(['a', 'b']);
    expect([...m!.required].sort()).toEqual(['a', 'b']);
  });
  it('falls back (undefined) when any step has no contract, or types conflict', () => {
    expect(mergeInputContracts([cap({ a: 'string' }, []), { capabilityId: 'x' } as unknown as Capability])).toBeUndefined();
    expect(mergeInputContracts([cap({ a: 'string' }, []), cap({ a: 'number' }, [])])).toBeUndefined();
    expect(mergeInputContracts([undefined])).toBeUndefined();
  });
});
