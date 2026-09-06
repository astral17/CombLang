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
  if (value.elseOutputs !== undefined) {
    outputBindingFailure(
      'A decider with an else branch cannot be rebound to one destination Signal.',
      value,
      source,
    );
  }
  if ((value.outputs?.length ?? 1) !== 1) {
    outputBindingFailure(
      'A multi-output decider cannot be rebound to one destination Signal.',
      value,
      source,
    );
  }
  const output = value.output;
  if (output === undefined) {
    outputBindingFailure('An incomplete decider has no output Signal to bind yet.', value, source);
  }
  if (output.kind === 'signal') {
    if (!sameSignal(output.signal, signal)) {
      outputBindingFailure(
        'Decider output Signal conflicts with its destination binding.',
        value,
        source,
      );
    }
    return value;
  }
  if (output.kind === 'each') {
    return {
      ...value,
      output: {
        kind: 'signal',
        ...(output.refKind === 'single'
          ? { refKind: 'single' as const, network: output.network }
          : { refKind: 'pair' as const, networks: output.networks }),
        signal,
      },
    };
  }
  if (output.kind === 'each-constant') {
    return {
      ...value,
      output: { kind: 'signal-constant', signal, value: output.value },
    };
  }
  return outputBindingFailure(
    'Wildcard decider output cannot be rebound to a concrete Signal.',
    value,
    source,
  );
}
