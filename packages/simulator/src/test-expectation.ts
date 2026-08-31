import { int32, signalKey, SparseBus, type SignalId } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';

import type { BusValue, UnknownOrigin } from './bus-value.js';
import type { TestBusInput } from './test-session.js';

interface AssertionContext {
  readonly currentTick: number;
  readValue(networkId: NetworkId): BusValue;
}

export interface TestSignalTarget<Target> {
  readonly kind: 'test-signal';
  readonly network: Target;
  readonly signal: SignalId;
}

export interface TestAssertionDetails {
  readonly tick: number;
  readonly target: string;
  readonly matcher: string;
  readonly expected: string;
  readonly actual: string;
  readonly origins?: readonly UnknownOrigin[];
}

function formatOrigins(origins: readonly UnknownOrigin[]): string {
  return origins
    .map((origin) => {
      const path = origin.path.length === 0 ? '' : ` via ${origin.path.join(' -> ')}`;
      return `  - ${origin.description} [${origin.id}]${path}`;
    })
    .join('\n');
}

export class TestAssertionError extends Error {
  readonly details: TestAssertionDetails;

  constructor(details: TestAssertionDetails) {
    const origins = details.origins;
    super(
      `Test assertion failed at tick ${details.tick} for ${details.target}: ` +
        `${details.matcher}\nExpected: ${details.expected}\nActual: ${details.actual}` +
        (origins === undefined ? '' : `\nUnknown origins:\n${formatOrigins(origins)}`),
    );
    this.name = 'TestAssertionError';
    this.details = details;
  }
}

function busText(bus: SparseBus): string {
  return JSON.stringify(bus.toJSON());
}

function valueText(value: BusValue): string {
  return value.kind === 'known' ? busText(value.bus) : 'Unknown';
}

function equalBuses(left: SparseBus, right: SparseBus): boolean {
  return busText(left) === busText(right);
}

abstract class BaseExpectation {
  readonly #context: AssertionContext;
  readonly #networkId: NetworkId;
  readonly #target: string;

  protected constructor(context: AssertionContext, networkId: NetworkId, target: string) {
    this.#context = context;
    this.#networkId = networkId;
    this.#target = target;
  }

  protected value(): BusValue {
    return this.#context.readValue(this.#networkId);
  }

  protected known(matcher: string, expected: string): SparseBus {
    const value = this.value();
    if (value.kind === 'unknown') this.fail(matcher, expected, value);
    return value.bus;
  }

  protected fail(matcher: string, expected: string, actual: BusValue | string): never {
    const value = typeof actual === 'string' ? undefined : actual;
    throw new TestAssertionError({
      tick: this.#context.currentTick,
      target: this.#target,
      matcher,
      expected,
      actual: typeof actual === 'string' ? actual : valueText(actual),
      ...(value?.kind === 'unknown' ? { origins: value.origins } : {}),
    });
  }

  toBeKnown(): void {
    const value = this.value();
    if (value.kind !== 'known') this.fail('toBeKnown()', 'Known', value);
  }

  toBeUnknown(): void {
    const value = this.value();
    if (value.kind !== 'unknown') this.fail('toBeUnknown()', 'Unknown', value);
  }
}

export class NetworkExpectation extends BaseExpectation {
  constructor(context: AssertionContext, networkId: NetworkId) {
    super(context, networkId, `Network ${networkId}`);
  }

  toEqual(expected: TestBusInput): void {
    const expectedBus = expected instanceof SparseBus ? expected.clone() : new SparseBus(expected);
    const actual = this.known('toEqual()', busText(expectedBus));
    if (!equalBuses(actual, expectedBus)) {
      this.fail('toEqual()', busText(expectedBus), busText(actual));
    }
  }

  toContain(expected: TestBusInput): void {
    const expectedBus = expected instanceof SparseBus ? expected.clone() : new SparseBus(expected);
    const actual = this.known('toContain()', busText(expectedBus));
    if (expectedBus.entries().some(([signal, value]) => actual.get(signal) !== value)) {
      this.fail('toContain()', busText(expectedBus), busText(actual));
    }
  }

  toBeEmpty(): void {
    const actual = this.known('toBeEmpty()', '[]');
    if (actual.size !== 0) this.fail('toBeEmpty()', '[]', busText(actual));
  }

  toHaveSignal(signal: SignalId, expectedValue?: number): void {
    if (expectedValue !== undefined && int32(expectedValue) === 0) {
      throw new RangeError(
        'toHaveSignal cannot expect zero because zero is absent from a SparseBus; use a signal toBe(0) assertion.',
      );
    }
    const expected =
      expectedValue === undefined
        ? `non-zero ${signalKey(signal)}`
        : `${signalKey(signal)}=${int32(expectedValue)}`;
    const actual = this.known('toHaveSignal()', expected);
    const value = actual.get(signal);
    const matches = expectedValue === undefined ? value !== 0 : value === int32(expectedValue);
    if (!matches) this.fail('toHaveSignal()', expected, busText(actual));
  }

  toHaveSupport(...signals: readonly SignalId[]): void {
    const expected = [...new Set(signals.map(signalKey))].sort();
    const actualBus = this.known('toHaveSupport()', JSON.stringify(expected));
    const actual = actualBus.entries().map(([signal]) => signalKey(signal));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      this.fail('toHaveSupport()', JSON.stringify(expected), JSON.stringify(actual));
    }
  }
}

export class SignalExpectation extends BaseExpectation {
  readonly #signal: SignalId;

  constructor(context: AssertionContext, networkId: NetworkId, signal: SignalId) {
    super(context, networkId, `Signal ${signalKey(signal)} on Network ${networkId}`);
    this.#signal = signal;
  }

  toBe(expected: number): void {
    const normalized = int32(expected);
    const actual = this.known('toBe()', String(normalized)).get(this.#signal);
    if (actual !== normalized) this.fail('toBe()', String(normalized), String(actual));
  }
}
