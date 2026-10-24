import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
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
  executeResolvedDirectPlan,
  type DirectPlanTestTarget,
  type ExecutedDirectPlan,
} from './direct-plan.js';
import { elaborateDirectPlan } from './direct-plan.js';
import type { NetworkHandle } from './elaboration.js';
import {
  assertBlueprintParameterExactKeys,
  createBlueprintParameterDataBudget,
  openBlueprintParameterArray,
  openBlueprintParameterRecord,
} from '../../compiler/src/blueprint-parameter-validation.js';
import { BlueprintParameterError } from '../../compiler/src/blueprint-parameters.js';

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
type RegisterTest = (name: string, body: TestBody, options?: unknown) => void;

interface RegisteredTest {
  readonly name: string;
  readonly body: TestBody;
  readonly hasParameters: boolean;
  readonly parameters?: unknown;
  readonly metadataError?: unknown;
  readonly hasMetadataError: boolean;
}

interface TestParameterOptions {
  readonly hasParameters: boolean;
  readonly parameters?: unknown;
}

function snapshotTestParameterData(
  value: unknown,
  path: string,
  depth: number,
  budget: ReturnType<typeof createBlueprintParameterDataBudget>,
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const opened = openBlueprintParameterArray(value, path, depth, budget);
    try {
      return Object.freeze(
        opened.value.map((entry, index) =>
          snapshotTestParameterData(entry, `${path}[${index}]`, depth + 1, budget),
        ),
      );
    } finally {
      opened.release();
    }
  }
  if (typeof value === 'object') {
    const opened = openBlueprintParameterRecord(value, path, depth, budget);
    try {
      const copy = Object.create(null) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(opened.value)) {
        copy[key] = snapshotTestParameterData(entry, `${path}.${key}`, depth + 1, budget);
      }
      return Object.freeze(copy);
    } finally {
      opened.release();
    }
  }
  throw new BlueprintParameterError(
    'CP1000',
    path,
    'only bounded plain parameter data is supported.',
  );
}

function readTestParameterOptions(options: unknown): TestParameterOptions {
  const budget = createBlueprintParameterDataBudget();
  const opened = openBlueprintParameterRecord(options, '$.options', 0, budget);
  try {
    assertBlueprintParameterExactKeys(opened.value, ['parameters'], '$.options');
    if (!Object.hasOwn(opened.value, 'parameters')) return { hasParameters: false };
    if (opened.value.parameters === undefined) {
      throw new BlueprintParameterError(
        'CP1000',
        '$.options.parameters',
        'expected an override array when the parameters field is supplied.',
      );
    }
    return {
      hasParameters: true,
      parameters: snapshotTestParameterData(
        opened.value.parameters,
        '$.options.parameters',
        1,
        budget,
      ),
    };
  } finally {
    opened.release();
  }
}

/** Internal shared check for runners that do not own a source binding session. */
export function assertEmptyTestParameterOverrides(parameters: unknown): void {
  if (parameters === undefined) return;
  const opened = openBlueprintParameterArray(
    parameters,
    '$.options.parameters',
    0,
    createBlueprintParameterDataBudget(),
  );
  try {
    if (opened.value.length !== 0) {
      throw new BlueprintParameterError(
        'CP1000',
        '$.options.parameters',
        'this test runner does not own source parameter declarations; only [] is accepted.',
      );
    }
  } finally {
    opened.release();
  }
}

/** Internal bounded snapshot helper shared with the host-local source adapter. */
export function snapshotTestParameterOverrides(value: unknown): unknown {
  return snapshotTestParameterData(
    value,
    '$.options.parameters',
    0,
    createBlueprintParameterDataBudget(),
  );
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorLocation(
  error: unknown,
  sourceName: string,
  stackLineOffset: number,
): { line?: number; column?: number } {
  if (isBlueprintParameterFailure(error)) return {};
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
  const parameterError = isBlueprintParameterFailure(error) ? error : undefined;
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
  return {
    ...common,
    failureKind: 'runtime',
    ...(parameterError !== undefined
      ? {
          code: parameterError.code,
          details: {
            ...(parameterError.path === undefined ? {} : { path: parameterError.path }),
            ...(parameterError.span === undefined
              ? {}
              : {
                  source: {
                    fileId: parameterError.span.fileId,
                    start: parameterError.span.start,
                    end: parameterError.span.end,
                  },
                }),
          },
        }
      : {}),
  };
}

interface TestExecutionDiagnosticError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly span?: { readonly fileId: string; readonly start: number; readonly end: number };
}

function isBlueprintParameterFailure(error: unknown): error is TestExecutionDiagnosticError {
  if (error instanceof BlueprintParameterError) return true;
  if (
    !(error instanceof Error) ||
    (error.name !== 'BlueprintParameterError' && error.name !== 'TestBindingError')
  ) {
    return false;
  }
  const value = error as Error & {
    readonly code?: unknown;
    readonly path?: unknown;
    readonly span?: unknown;
  };
  return (
    typeof value.code === 'string' &&
    (value.path === undefined || typeof value.path === 'string') &&
    (value.span === undefined ||
      (typeof value.span === 'object' &&
        value.span !== null &&
        typeof (value.span as { readonly fileId?: unknown }).fileId === 'string' &&
        Number.isSafeInteger((value.span as { readonly start?: unknown }).start) &&
        Number.isSafeInteger((value.span as { readonly end?: unknown }).end)))
  );
}

export function runTestsWithExecution(
  getExecution: (caseParameters?: unknown) => ExecutedDirectPlan,
  source: string,
  options: DirectPlanTestRunnerOptions = {},
): DirectPlanTestRun {
  const setup = registerTests(source, options);
  if ('failure' in setup) return setup.failure;
  const results = setup.registered.map((registeredTest) => {
    if (registeredTest.hasMetadataError) {
      return failure(
        registeredTest.name,
        registeredTest.metadataError,
        setup.sourceName,
        setup.stackLineOffset,
      );
    }
    let execution: ExecutedDirectPlan;
    try {
      execution = getExecution(
        registeredTest.hasParameters ? registeredTest.parameters : undefined,
      );
    } catch (error) {
      return failure(registeredTest.name, error, setup.sourceName, setup.stackLineOffset);
    }
    return runRegisteredTest(registeredTest, execution, setup.sourceName, setup.stackLineOffset);
  });
  return aggregateTestResults(results);
}

/** Runs cases sequentially while asynchronously resolving each case's execution. */
export async function runTestsWithExecutionResolver(
  resolveExecution: (caseParameters?: unknown) => Promise<ExecutedDirectPlan>,
  source: string,
  options: DirectPlanTestRunnerOptions = {},
): Promise<DirectPlanTestRun> {
  const setup = registerTests(source, options);
  if ('failure' in setup) return setup.failure;
  const results: DirectPlanTestCaseResult[] = [];
  for (const registeredTest of setup.registered) {
    if (registeredTest.hasMetadataError) {
      results.push(
        failure(
          registeredTest.name,
          registeredTest.metadataError,
          setup.sourceName,
          setup.stackLineOffset,
        ),
      );
      continue;
    }
    let execution: ExecutedDirectPlan;
    try {
      execution = await resolveExecution(
        registeredTest.hasParameters ? registeredTest.parameters : undefined,
      );
    } catch (error) {
      results.push(failure(registeredTest.name, error, setup.sourceName, setup.stackLineOffset));
      continue;
    }
    results.push(
      runRegisteredTest(registeredTest, execution, setup.sourceName, setup.stackLineOffset),
    );
  }
  return aggregateTestResults(results);
}

interface RegisteredTestSetup {
  readonly registered: readonly RegisteredTest[];
  readonly sourceName: string;
  readonly stackLineOffset: number;
}

function registerTests(
  source: string,
  options: DirectPlanTestRunnerOptions,
): RegisteredTestSetup | { readonly failure: DirectPlanTestRun } {
  const sourceName = options.sourceName ?? 'circuit.test.js';
  const stackLineOffset = options.stackLineOffset ?? 3;
  if (/[\r\n\u2028\u2029]/.test(sourceName)) {
    throw new TypeError('Test source name cannot contain a newline.');
  }
  if (!Number.isSafeInteger(stackLineOffset) || stackLineOffset < 0) {
    throw new RangeError('Test stack line offset must be a non-negative safe integer.');
  }

  const registered: RegisteredTest[] = [];
  const test: RegisterTest = function (name, body, options) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError('test(name, body) requires a non-empty name.');
    }
    if (typeof body !== 'function') throw new TypeError(`Test "${name}" requires a function body.`);
    let testOptions: TestParameterOptions = { hasParameters: false };
    let metadataError: unknown;
    let hasMetadataError = false;
    if (arguments.length >= 3) {
      try {
        testOptions = readTestParameterOptions(options);
      } catch (error) {
        metadataError = error;
        hasMetadataError = true;
      }
    }
    registered.push({
      name,
      body,
      hasParameters: testOptions.hasParameters,
      ...(testOptions.hasParameters ? { parameters: testOptions.parameters } : {}),
      ...(hasMetadataError ? { metadataError } : {}),
      hasMetadataError,
    });
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
      failure: {
        results: [failure('Test file', error, sourceName, stackLineOffset)],
        passed: 0,
        failed: 1,
      },
    };
  }
  return { registered, sourceName, stackLineOffset };
}

function runRegisteredTest(
  registeredTest: RegisteredTest,
  execution: ExecutedDirectPlan,
  sourceName: string,
  stackLineOffset: number,
): DirectPlanTestCaseResult {
  const session = execution.createTestSession();
  const debug = createDebugDocument(execution.debug, execution.circuit.graph);
  const traceNetworkNames = Object.freeze(
    Object.fromEntries([
      ...execution.circuit.ir.networks.map(({ id, name }) => [id, name ?? id] as const),
      ...execution.debug.scopes
        .toReversed()
        .flatMap((scope) =>
          scope.networks
            .filter(({ internal, moved }) => !internal && !moved)
            .map(({ id, name }) => [id, name] as const),
        ),
    ]),
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
      ...failure(registeredTest.name, error, sourceName, stackLineOffset, session.traces.toJSON()),
      traceNetworkNames,
      debug,
    };
  } finally {
    session.finish();
  }
}

function aggregateTestResults(results: readonly DirectPlanTestCaseResult[]): DirectPlanTestRun {
  const passed = results.filter(({ status }) => status === 'passed').length;
  return { results, passed, failed: results.length - passed };
}

/** Runs tests with a circuit already produced by the shared compilation service. */
export function runExecutedDirectPlanTests(
  execution: ExecutedDirectPlan,
  source: string,
  options: DirectPlanTestRunnerOptions = {},
): DirectPlanTestRun {
  return runTestsWithExecution(
    (parameters) => {
      assertEmptyTestParameterOverrides(parameters);
      return execution;
    },
    source,
    options,
  );
}

/** Compatibility entry point for callers that only own a serializable Direct Plan. */
export function runDirectPlanTests(
  plan: DirectElaborationPlan,
  source: string,
  options: DirectPlanTestRunnerOptions = {},
): DirectPlanTestRun {
  let attempted = false;
  let execution: ExecutedDirectPlan | undefined;
  let failure: unknown;
  const getExecution = (parameters?: unknown): ExecutedDirectPlan => {
    assertEmptyTestParameterOverrides(parameters);
    if (!attempted) {
      attempted = true;
      try {
        execution = elaborateDirectPlan(plan);
      } catch (error) {
        failure = error;
      }
    }
    if (execution !== undefined) return execution;
    throw failure;
  };
  return runTestsWithExecution(getExecution, source, options);
}

/** Runs tests against an already-resolved, fingerprint-paired physical circuit. */
export function runResolvedDirectPlanTests(
  plan: DirectElaborationPlan,
  resolvedCircuit: unknown,
  source: string,
  options: DirectPlanTestRunnerOptions = {},
): DirectPlanTestRun {
  let execution: ExecutedDirectPlan;
  try {
    execution = executeResolvedDirectPlan(plan, resolvedCircuit);
  } catch (error) {
    const sourceName = options.sourceName ?? 'circuit.test.js';
    const stackLineOffset = options.stackLineOffset ?? 3;
    return {
      results: [failure('Circuit setup', error, sourceName, stackLineOffset)],
      passed: 0,
      failed: 1,
    };
  }
  return runTestsWithExecution(
    (parameters) => {
      assertEmptyTestParameterOverrides(parameters);
      return execution;
    },
    source,
    options,
  );
}
