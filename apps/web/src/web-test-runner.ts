import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan';
import { Signal, type SignalId } from '@comblang/factorio';
import { elaborateDirectPlan, type NetworkHandle } from '@comblang/runtime';
import type { NetworkExpectation, SignalExpectation, TestBusInput } from '@comblang/simulator';

export interface WebTestResult {
  readonly name: string;
  readonly status: 'passed' | 'failed';
  readonly message?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface WebTestRun {
  readonly results: readonly WebTestResult[];
  readonly passed: number;
  readonly failed: number;
}

interface WebTestApi {
  network(name: string): NetworkHandle;
  drive(network: NetworkHandle, values: TestBusInput): void;
  clear(network: NetworkHandle): void;
  pulse(network: NetworkHandle, values: TestBusInput): void;
  tick(count?: number): void;
  run(count: number): void;
  expect(network: NetworkHandle): NetworkExpectation;
  expectSignal(network: NetworkHandle, signal: SignalId): SignalExpectation;
}

type TestBody = (api: WebTestApi) => unknown;
type RegisterTest = (name: string, body: TestBody) => void;

interface RegisteredTest {
  readonly name: string;
  readonly body: TestBody;
}

function errorLocation(error: unknown): { line?: number; column?: number } {
  if (!(error instanceof Error) || error.stack === undefined) return {};
  const match = /circuit\.test\.js:(\d+):(\d+)/.exec(error.stack);
  if (match === null) return {};
  const rawLine = Number(match[1]);
  const column = Number(match[2]);
  // Function bodies start three lines below the synthetic wrapper in browsers and Node.
  return {
    line: Math.max(1, rawLine - 3),
    ...(Number.isFinite(column) ? { column } : {}),
  };
}

function failure(name: string, error: unknown): WebTestResult {
  const location = errorLocation(error);
  return {
    name,
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
    ...location,
  };
}

export function runWebTests(plan: DirectElaborationPlan, source: string): WebTestRun {
  const registered: RegisteredTest[] = [];
  const test: RegisterTest = (name, body) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError('test(name, body) requires a non-empty name.');
    }
    if (typeof body !== 'function') throw new TypeError(`Test "${name}" requires a function body.`);
    registered.push({ name, body });
  };

  try {
    const execute = new Function(
      'test',
      'Signal',
      `"use strict";\n${source}\n//# sourceURL=circuit.test.js`,
    ) as (test: RegisterTest, Signal: typeof import('@comblang/factorio').Signal) => void;
    execute(test, Signal);
  } catch (error) {
    return { results: [failure('Test file', error)], passed: 0, failed: 1 };
  }

  const results = registered.map((registeredTest): WebTestResult => {
    try {
      const executed = elaborateDirectPlan(plan);
      const session = executed.circuit.createTestSession();
      const api: WebTestApi = {
        network: (name) => executed.network(name),
        drive: (network, values) => {
          session.drive(network, values);
        },
        clear: (network) => {
          session.clear(network);
        },
        pulse: (network, values) => {
          session.pulse(network, values);
        },
        tick: (count) => {
          session.tick(count);
        },
        run: (count) => {
          session.run(count);
        },
        expect: (network) => session.expect(network),
        expectSignal: (network, signal) => session.expectSignal(network, signal),
      };
      const returned = registeredTest.body(api);
      if (returned instanceof Promise) {
        throw new TypeError('Async browser tests are not supported yet.');
      }
      return { name: registeredTest.name, status: 'passed' };
    } catch (error) {
      return failure(registeredTest.name, error);
    }
  });
  const passed = results.filter(({ status }) => status === 'passed').length;
  return { results, passed, failed: results.length - passed };
}
