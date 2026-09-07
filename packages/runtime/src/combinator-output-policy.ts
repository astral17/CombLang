import { sameSignal, type SignalId } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { CombinatorDescriptor } from './elaboration-values.js';

function outputBindingFailure(
  message: string,
  value: CombinatorDescriptor,
  source: SourceSpan,
): never {
  const related = [{ message: 'Physical combinator was created here.', span: value.source }].filter(
    (entry, index, entries) =>
      entries.findIndex(
        (candidate) =>
          candidate.span.fileId === entry.span.fileId &&
          candidate.span.start === entry.span.start &&
          candidate.span.end === entry.span.end,
      ) === index &&
      !(
        entry.span.fileId === source.fileId &&
        entry.span.start === source.start &&
        entry.span.end === source.end
      ),
  );
  throw new ElaborationExecutionError(message, source, 'RT2023', related);
}

/** Mutates a destination Signal constraint for one physical combinator configuration. */
export function bindCombinatorOutputSignal(
  value: CombinatorDescriptor,
  signal: SignalId | undefined,
  source: SourceSpan,
): CombinatorDescriptor {
  if (signal === undefined) return value;
  if (value.kind === 'constant') {
    outputBindingFailure(
      'A constant combinator output cannot be rebound to another Signal.',
      value,
      source,
    );
  }
  if (value.kind === 'arithmetic') {
    return { ...value, output: { kind: 'signal', signal } };
  }
  const thenOutputs =
    value.outputs ??
    (value.elseOutputs === undefined && value.output !== undefined ? [value.output] : []);
  const elseOutputs = value.elseOutputs ?? [];
  if (thenOutputs.length > 1 || elseOutputs.length > 1) {
    outputBindingFailure(
      'A multi-output decider branch cannot be rebound to one destination Signal.',
      value,
      source,
    );
  }
  const output = value.output;
  if (output === undefined) {
    // Keep the binding in the registry until a later .then/.else mutation supplies
    // the output descriptor.
    return value;
  }
  const bindOutput = (candidate: typeof output): typeof output => {
    if (candidate.kind === 'signal') {
      if (!sameSignal(candidate.signal, signal)) {
        outputBindingFailure(
          'Decider output Signal conflicts with its destination binding.',
          value,
          source,
        );
      }
      return candidate;
    }
    if (candidate.kind === 'each') {
      return {
        kind: 'signal',
        ...(candidate.refKind === 'single'
          ? { refKind: 'single', network: candidate.network }
          : { refKind: 'pair', networks: candidate.networks }),
        signal,
      };
    }
    if (candidate.kind === 'each-constant') {
      return { kind: 'signal-constant', signal, value: candidate.value };
    }
    return outputBindingFailure(
      'Wildcard decider output cannot be rebound to a concrete Signal.',
      value,
      source,
    );
  };
  const boundThen = thenOutputs.map(bindOutput);
  const boundElse = elseOutputs.map(bindOutput);
  return {
    ...value,
    output: boundThen[0] ?? boundElse[0]!,
    ...(value.outputs === undefined ? {} : { outputs: boundThen }),
    ...(value.elseOutputs === undefined ? {} : { elseOutputs: boundElse }),
  };
}
