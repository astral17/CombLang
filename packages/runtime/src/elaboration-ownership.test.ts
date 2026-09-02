import { sourceFileId, sourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { ElaborationExecutionError } from './elaboration-errors.js';
import { createElaborationOwnershipPolicy } from './elaboration-ownership.js';
import type {
  FunctionOwnershipFrame,
  NetworkOwnershipState,
  NetworkRuntimeState,
  NetworkValue,
} from './elaboration-values.js';
import { RuntimeValueRegistry } from './elaboration-values.js';

const file = sourceFileId('ownership-policy.factorio.ts');
const span = (start: number) => sourceSpan(file, start, start + 1);

const registry = new RuntimeValueRegistry();
const stateFor = (network: NetworkValue): NetworkRuntimeState => {
  const state = registry.networkState(network);
  if (state === undefined) throw new Error('Missing test Network state.');
  return state;
};
const ownership = createElaborationOwnershipPolicy(stateFor);

function ownedNetwork(state?: NetworkOwnershipState): NetworkValue {
  const ownership =
    state ??
    ({
      generation: 0,
      owner: 'top-level',
      readonlyBorrows: new Set(),
    } satisfies NetworkOwnershipState);
  return registry.brandNetwork(
    {
      kind: 'network',
      name: 'value',
      declaration: span(0),
      capability: 'owned',
      generation: ownership.generation,
    },
    { ownership },
  );
}

function view(
  value: NetworkValue,
  capability: NetworkValue['capability'],
  borrow?: NetworkRuntimeState['borrow'],
): NetworkValue {
  const state = stateFor(value);
  return registry.brandNetwork(
    { ...value, capability, generation: state.ownership.generation },
    { ownership: state.ownership, ...(borrow === undefined ? {} : { borrow }) },
  );
}

function frame(name: string): FunctionOwnershipFrame {
  return { owner: Symbol(name), source: span(10), borrows: [], moves: [] };
}

describe('elaboration ownership policy', () => {
  test('creates and releases a nominal borrow lifecycle', () => {
    const value = ownedNetwork();
    const current = frame('borrow');
    const borrow = ownership.borrow(value, 'readonly', 'input', span(20), current);
    const readonlyView = view(value, 'readonly', borrow);

    ownership.assertReadable(readonlyView, span(21));
    expect(() => ownership.assertWritable(readonlyView, span(22))).toThrowError(
      expect.objectContaining({ code: 'RT2015' }),
    );
    ownership.releaseFrame(current, span(23));
    expect(() => ownership.assertReadable(readonlyView, span(24))).toThrowError(
      expect.objectContaining({ code: 'RT2017' }),
    );
  });

  test('moves ownership to a function and returns it to the caller', () => {
    const original = ownedNetwork();
    const current = frame('move');
    ownership.moveToFrame(original, span(30), current);
    expect(() => ownership.assertReadable(original, span(31))).toThrowError(
      expect.objectContaining({ code: 'RT2012' }),
    );

    const moved = view(original, 'move');
    const generation = stateFor(moved).ownership.generation;
    ownership.assertReturnable(moved, span(32), current);
    expect(stateFor(moved).ownership.generation).toBe(generation);
    expect(stateFor(moved).ownership.owner).toBe(current.owner);
    expect(current.moves[0]?.returned).toBe(false);
    ownership.returnToCaller(moved, span(32), current, undefined);
    expect(stateFor(original).ownership.owner).toBe('top-level');
    expect(current.moves[0]?.returned).toBe(true);
  });

  test('reports dropped ownership and conflicting color requirements', () => {
    const value = ownedNetwork();
    const current = frame('drop');
    ownership.moveToFrame(value, span(40), current);
    const moved = view(value, 'move');
    ownership.releaseFrame(current);

    try {
      ownership.assertReadable(moved, span(41));
      throw new Error('Expected dropped ownership to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      expect(error).toMatchObject({ code: 'RT2019' });
    }

    const colored = ownedNetwork();
    expect(ownership.requireColor(colored, 'readonly', 'red', span(50))).toBe(true);
    expect(ownership.requireColor(colored, 'ref', 'red', span(51))).toBe(false);
    expect(() => ownership.requireColor(colored, 'move', 'green', span(52))).toThrowError(
      expect.objectContaining({ code: 'RT2018' }),
    );
  });
});
