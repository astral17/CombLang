import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import type {
  NetworkOwnershipState,
  NetworkValue,
  PairSelectedValue,
  PairValue,
  CombinatorValue,
} from './elaboration-values.js';
import {
  returnOwnedValue,
  type ReturnOwnedValuePolicyContext,
} from './return-owned-value-policy.js';

const fileId = 'file:return.ts' as SourceFileId;
const source = { fileId, start: 50, end: 60 };

function network(name: string, start: number): NetworkValue {
  return {
    kind: 'network',
    name,
    declaration: { fileId, start, end: start + 1 },
    capability: 'owned',
    generation: 0,
  };
}

function ownership(): NetworkOwnershipState {
  return { generation: 0, owner: Symbol('owner'), readonlyBorrows: new Set() };
}

function policy(
  owners: ReadonlyMap<NetworkValue, NetworkOwnershipState>,
  overrides: Partial<ReturnOwnedValuePolicyContext> = {},
): ReturnOwnedValuePolicyContext {
  return {
    isCombinator: (value): value is CombinatorValue =>
      typeof value === 'object' &&
      value !== null &&
      (value as { kind?: unknown }).kind === 'combinator',
    isNetwork: (value): value is NetworkValue =>
      typeof value === 'object' &&
      value !== null &&
      (value as { kind?: unknown }).kind === 'network',
    isPair: (value): value is PairValue =>
      typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'pair',
    isPairSelection: (value): value is PairSelectedValue =>
      typeof value === 'object' &&
      value !== null &&
      (value as { kind?: unknown }).kind === 'selected' &&
      Array.isArray((value as { networks?: unknown }).networks),
    assertReturnable: vi.fn(),
    ownershipOf: (value) => owners.get(value)!,
    combinatorNetworks: () => [],
    normalizeCombinator: (value) => value,
    isConsumed: () => false,
    isOwnedByReturnFrame: () => true,
    updateCombinatorNetwork: vi.fn(),
    chargeTransfer: vi.fn(),
    returnNetwork: (value) => ({ ...value, name: `${value.name}:returned` }),
    ...overrides,
  };
}

describe('return-owned value policy', () => {
  test('rebuilds cyclic containers while preserving aliases and replacing each Network once', () => {
    const first = network('first', 1);
    const second = network('second', 2);
    const root: { self?: unknown; shared?: unknown; values: unknown[] } = {
      values: [first, second],
    };
    root.self = root;
    root.shared = root.values;
    const returnNetwork = vi.fn((value: NetworkValue) => ({
      ...value,
      name: `${value.name}:returned`,
    }));

    const result = returnOwnedValue(
      root,
      source,
      policy(
        new Map([
          [first, ownership()],
          [second, ownership()],
        ]),
        { returnNetwork },
      ),
    ) as typeof root;

    expect(result).not.toBe(root);
    expect(result.self).toBe(result);
    expect(result.shared).toBe(result.values);
    expect(result.values).toMatchObject([{ name: 'first:returned' }, { name: 'second:returned' }]);
    expect(root.values).toEqual([first, second]);
    expect(returnNetwork).toHaveBeenCalledTimes(2);
  });

  test('rejects a pair view with its creation provenance', () => {
    const first = network('first', 1);
    const second = network('second', 2);
    const pairSource = { fileId, start: 20, end: 30 };
    const pair: PairValue = { kind: 'pair', networks: [first, second], source: pairSource };

    expect(() => returnOwnedValue(pair, source, policy(new Map()))).toThrowError(
      expect.objectContaining({
        code: 'RT2020',
        span: source,
        related: [{ message: 'The pair view was created here.', span: pairSource }],
      }),
    );
  });

  test('rejects two handles for the same physical ownership before charging transfers', () => {
    const first = network('first', 1);
    const alias = network('first-alias', 2);
    const owner = ownership();
    const chargeTransfer = vi.fn();

    expect(() =>
      returnOwnedValue(
        [first, alias],
        source,
        policy(
          new Map([
            [first, owner],
            [alias, owner],
          ]),
          { chargeTransfer },
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: 'RT2012', span: source }));
    expect(chargeTransfer).not.toHaveBeenCalled();
  });

  test('charges every transfer before mutating the first Network', () => {
    const first = network('first', 1);
    const second = network('second', 2);
    const returnNetwork = vi.fn((value: NetworkValue) => value);
    let charges = 0;

    expect(() =>
      returnOwnedValue(
        [first, second],
        source,
        policy(
          new Map([
            [first, ownership()],
            [second, ownership()],
          ]),
          {
            chargeTransfer() {
              charges += 1;
              if (charges === 2) throw new Error('budget exhausted');
            },
            returnNetwork,
          },
        ),
      ),
    ).toThrow('budget exhausted');
    expect(returnNetwork).not.toHaveBeenCalled();
  });

  test('preserves a foreign Combinator handle without claiming its output ownership', () => {
    const primary = network('primary', 1);
    const combinator: CombinatorValue = { kind: 'combinator', identity: {} };
    const assertReturnable = vi.fn();
    const returnNetwork = vi.fn((value: NetworkValue) => value);

    const result = returnOwnedValue(
      combinator,
      source,
      policy(new Map([[primary, ownership()]]), {
        combinatorNetworks: () => [primary],
        isOwnedByReturnFrame: () => false,
        assertReturnable,
        returnNetwork,
      }),
    );

    expect(result).toBe(combinator);
    expect(assertReturnable).not.toHaveBeenCalled();
    expect(returnNetwork).not.toHaveBeenCalled();
  });

  test('restores scoped Combinator handles inside returned containers', () => {
    const original: CombinatorValue = { kind: 'combinator', identity: {} };
    const scoped: CombinatorValue = {
      kind: 'combinator',
      identity: original.identity,
      unrestrictedHandle: original,
    };

    const result = returnOwnedValue(
      { value: scoped },
      source,
      policy(new Map(), {
        normalizeCombinator: (value) => value.unrestrictedHandle ?? value,
      }),
    ) as { value: CombinatorValue };

    expect(result.value).toBe(original);
  });
});
