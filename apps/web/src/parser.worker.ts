/// <reference lib="webworker" />

import {
  classifyDslSemantics,
  parseFile,
  summarizeTopLevel,
  validateDslSemantics,
} from '@comblang/language';
import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import {
  ElaborationExecutionError,
  ElaborationOperationLimitError,
  executeElaborationProgram,
} from '@comblang/runtime';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan';
import type { Diagnostic } from '@comblang/shared';

import type { CompilerWorkerRequest, CompilerWorkerResponse } from './worker-protocol.js';

const worker = self as DedicatedWorkerGlobalScope;

worker.addEventListener('message', (event: MessageEvent<CompilerWorkerRequest>) => {
  if (event.data.kind !== 'parse') {
    return;
  }

  const parsed = parseFile(event.data.file);
  let plan: DirectElaborationPlan | undefined;
  let elaborationJavaScript: string | undefined;
  const semanticDiagnostics = validateDslSemantics(parsed);
  let compilerDiagnostics: readonly Diagnostic[] = semanticDiagnostics;
  if (parsed.diagnostics.length === 0) {
    try {
      const program = transformElaborationModule(parsed);
      elaborationJavaScript = program.code;
      if (!semanticDiagnostics.some(({ severity }) => severity === 'error')) {
        plan = executeElaborationProgram(program);
        compilerDiagnostics = [...semanticDiagnostics, ...(plan.diagnostics ?? [])];
      }
    } catch (error) {
      plan = undefined;
      compilerDiagnostics = [
        ...semanticDiagnostics,
        {
          code: error instanceof ElaborationOperationLimitError ? 'EX1003' : 'EX1001',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Elaboration execution failed.',
          ...(error instanceof ElaborationExecutionError ? { span: error.span } : {}),
        },
      ];
    }
  }
  const response: CompilerWorkerResponse = {
    kind: 'parsed',
    revision: event.data.revision,
    result: {
      fileId: parsed.id,
      diagnostics: parsed.diagnostics,
      topLevel: summarizeTopLevel(parsed),
      semantics: classifyDslSemantics(parsed),
      compilerDiagnostics,
      executionMode: 'executed-javascript',
      ...(elaborationJavaScript === undefined ? {} : { elaborationJavaScript }),
      ...(plan === undefined ? {} : { plan }),
    },
  };
  worker.postMessage(response);
});
