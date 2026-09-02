import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan';
import { Signal, type SignalId } from '@comblang/factorio';
import {
  TestAssertionError,
  type NetworkExpectation,
  type SignalExpectation,
  type TestBusInput,
  type TestSession,
  type TraceDocument,
} from '@comblang/simulator';

import { DebugQueryError } from './debug-index.js';
import { createDebugDocument, type DebugDocument } from './debug-document.js';
import { StructureAssertionError } from './debug-structure.js';
import {
  elaborateDirectPlan,
  type DirectPlanTestTarget,
  type ExecutedDirectPlan,
} from './direct-plan.js';
import type { NetworkHandle } from './elaboration.js';

export type DirectPlanTestFailureKind = 'assertion' | 'debug-query' | 'structure' | 'runtime';

export interface DirectPlanTestCaseResult {
  readonly name: string;
  readonly status: 'passed' | 'failed';
  readonly message?: string;
  readonly failureKind?: DirectPlanTestFailureKind;
  readonly code?: string;
  readonly details?: unknown;
  readonly candidates?: readonly string[];
  readonly line?: number;
  readonly column?: number;
  readonly trace?: TraceDocument;
  /** Display names from this execution, never inferred by matching another circuit's IDs. */
  readonly traceNetworkNames?: Readonly<Record<string, string>>;
  readonly debug?: DebugDocument;
  /** Exact query/structural failure scope; never parsed from candidate display text. */
  readonly debugScopePath?: readonly string[];
}

export interface DirectPlanTestRun {
  readonly results: readonly DirectPlanTestCaseResult[];
  readonly passed: number;
  readonly failed: number;
}

export interface DirectPlanTestApi {
  readonly execution: ExecutedDirectPlan;
  readonly session: TestSession<DirectPlanTestTarget>;
  network(name: string): NetworkHandle;
  drive(network: NetworkHandle, values: TestBusInput): void;
  clear(network: NetworkHandle): void;
  pulse(network: NetworkHandle, values: TestBusInput): void;
  tick(count?: number): void;
  run(count: number): void;
  expect(network: NetworkHandle): NetworkExpectation;
  expectSignal(network: NetworkHandle, signal: SignalId): SignalExpectation;
}

export interface DirectPlanTestRunnerOptions {
  readonly sourceName?: string;
  readonly stackLineOffset?: number;
}

type TestBody = (api: DirectPlanTestApi) => unknown;
type RegisterTest = (name: string, body: TestBody) => void;

interface RegisteredTest {
  readonly name: string;
  readonly body: TestBody;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorLocation(
  error: unknown,
  sourceName: string,
  stackLineOffset: number,
): { line?: number; column?: number } {
  if (!(error instanceof Error) || error.stack === undefined) return {};
  const match = new RegExp(`${regexEscape(sourceName)}:(\\d+):(\\d+)`).exec(error.stack);
  if (match === null) return {};
  const rawLine = Number(match[1]);
  const column = Number(match[2]);
  return {
    line: Math.max(1, rawLine - stackLineOffset),
    ...(Number.isFinite(column) ? { column } : {}),
  };
}

function failure(
  name: string,
  error: unknown,
  sourceName: string,
  stackLineOffset: number,
  trace?: TraceDocument,
): DirectPlanTestCaseResult {
  const location = errorLocation(error, sourceName, stackLineOffset);
  const common = {
    name,
    status: 'failed' as const,
    message: error instanceof Error ? error.message : String(error),
    ...location,
    ...(trace === undefined ? {} : { trace }),
  };
  if (error instanceof TestAssertionError) {
    return { ...common, failureKind: 'assertion', details: error.details };
  }
  if (error instanceof DebugQueryError) {
    return {
      ...common,
      failureKind: 'debug-query',
      code: error.code,
      candidates: error.candidates,
      ...(error.scopePath === undefined ? {} : { debugScopePath: error.scopePath }),
    };
  }
  if (error instanceof StructureAssertionError) {
    return {
      ...common,
      failureKind: 'structure',
      code: error.code,
      details: error.details,
      debugScopePath: error.details.scopePath,
    };
  }
  return { ...common, failureKind: 'runtime' };
}

/** Runs the temporary JavaScript test surface shared by browser and Node clients. */
export function runDirectPlanTests(
  plan: DirectElaborationPlan,
  source: string,
  options: DirectPlanTestRunnerOptions = {},
): DirectPlanTestRun {
  const sourceName = options.sourceName ?? 'circuit.test.js';
  const stackLineOffset = options.stackLineOffset ?? 3;
  if (/[\r\n\u2028\u2029]/.test(sourceName)) {
    throw new TypeError('Test source name cannot contain a newline.');
  }
  if (!Number.isSafeInteger(stackLineOffset) || stackLineOffset < 0) {
    throw new RangeError('Test stack line offset must be a non-negative safe integer.');
  }

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
      `"use strict";\n${source}\n//# sourceURL=${sourceName}`,
    ) as (test: RegisterTest, signal: typeof Signal) => void;
    execute(test, Signal);
  } catch (error) {
    return {
      results: [failure('Test file', error, sourceName, stackLineOffset)],
      passed: 0,
      failed: 1,
    };
  }

  const results = registered.map((registeredTest): DirectPlanTestCaseResult => {
    let execution: ExecutedDirectPlan;
    try {
      execution = elaborateDirectPlan(plan);
    } catch (error) {
      return failure(registeredTest.name, error, sourceName, stackLineOffset);
    }
    const session = execution.createTestSession();
    const debug = createDebugDocument(execution.debug, execution.circuit.graph);
    const traceNetworkNames = Object.freeze(
      Object.fromEntries(execution.circuit.ir.networks.map(({ id, name }) => [id, name ?? id])),
    );
    try {
      const api: DirectPlanTestApi = {
        execution,
        session,
        network: (name) => execution.network(name),
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
        throw new TypeError('Async tests are not supported yet.');
      }
      return {
        name: registeredTest.name,
        status: 'passed',
        trace: session.traces.toJSON(),
        traceNetworkNames,
        debug,
      };
    } catch (error) {
      return {
        ...failure(
          registeredTest.name,
          error,
          sourceName,
          stackLineOffset,
          session.traces.toJSON(),
        ),
        traceNetworkNames,
        debug,
      };
    } finally {
      session.finish();
    }
  });
  const passed = results.filter(({ status }) => status === 'passed').length;
  return { results, passed, failed: results.length - passed };
}
