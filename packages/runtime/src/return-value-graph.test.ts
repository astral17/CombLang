import { describe, expect, test } from 'vitest';

import { inspectReturnValueGraph } from './return-value-graph.js';

describe('return value graph', () => {
  test('copies only reverse-reachable containers and preserves shared cycles', () => {
    const handle = {};
    const replacement = {};
    const untouched: { self?: unknown } = {};
    untouched.self = untouched;
    const root: { left?: unknown; right?: unknown; untouched: unknown } = { untouched };
    const child = { parent: root, handle };
    root.left = child;
    root.right = child;
    const graph = inspectReturnValueGraph(root, (value) => value === handle);
    expect(graph.handles).toEqual([handle]);
    const result = graph.replace(new Map([[handle, replacement]])) as typeof root;
    expect(result).not.toBe(root);
    expect(result.left).toBe(result.right);
    expect(result.left).toEqual({ parent: result, handle: replacement });
    expect(result.untouched).toBe(untouched);
    expect(child.handle).toBe(handle);
    expect(child.parent).toBe(root);
    expect(graph.replace(new Map())).toBe(root);
  });

  test('records distinct handle slots but visits a shared container only once', () => {
    const handle = {};
    const shared = [handle];
    const graph = inspectReturnValueGraph(
      [shared, shared, { handle }],
      (value) => value === handle,
    );
    expect(graph.handles).toEqual([handle, handle]);
  });

  test('keeps descriptors, integrity, sparse arrays, symbols and lazy accessors', () => {
    const handle = {};
    const replacement = {};
    const key = Symbol('handle');
    let reads = 0;
    const array: unknown[] = [];
    array.length = 4;
    Object.defineProperty(array, 2, { value: handle, enumerable: false });
    Object.defineProperty(array, Symbol.iterator, {
      value() {
        throw new Error('must not iterate');
      },
    });
    Object.freeze(array);
    const root = Object.create(null);
    Object.defineProperties(root, {
      array: { value: array },
      lazy: {
        get() {
          reads++;
          return handle;
        },
      },
      [key]: { value: handle, writable: true },
    });
    Object.seal(root);
    const graph = inspectReturnValueGraph(root, (value) => value === handle);
    const result = graph.replace(new Map([[handle, replacement]])) as typeof root;
    expect(reads).toBe(0);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isSealed(result)).toBe(true);
    expect(Object.isFrozen(result.array)).toBe(true);
    expect(result.array.length).toBe(4);
    expect(0 in result.array).toBe(false);
    expect(result.array[2]).toBe(replacement);
    expect(result[key]).toBe(replacement);
    expect(Object.getOwnPropertyDescriptor(result.array, '2')).toMatchObject({ enumerable: false });
    expect(result.lazy).toBe(handle);
    expect(reads).toBe(1);
  });

  test('does not traverse Maps or class instances', () => {
    const handle = {};
    class Box {
      value = handle;
    }
    const root = { map: new Map([['value', handle]]), box: new Box() };
    const graph = inspectReturnValueGraph(root, (value) => value === handle);
    expect(graph.handles).toEqual([]);
    expect(graph.replace(new Map())).toBe(root);
  });

  test('traverses and rebuilds deeply nested graphs without recursion', () => {
    const handle = {};
    const replacement = {};
    let root: unknown = handle;
    for (let depth = 0; depth < 20_000; depth++) root = { child: root };
    const graph = inspectReturnValueGraph(root, (value) => value === handle);
    expect(graph.handles).toEqual([handle]);
    let result = graph.replace(new Map([[handle, replacement]]));
    for (let depth = 0; depth < 20_000; depth++) result = (result as { child: unknown }).child;
    expect(result).toBe(replacement);
  });
});
