import { sameSignal, type SignalId } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { ProducerValue } from './elaboration-values.js';

type BrandProducer = (value: ProducerValue) => ProducerValue;

function outputBindingFailure(message: string, value: ProducerValue, source: SourceSpan): never {
  const related = [
    { message: 'Physical producer was created here.', span: value.producer.source },
  ].filter(
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

/** Applies a destination Signal constraint without changing the physical Producer identity. */
export function bindProducerOutputSignal(
  value: ProducerValue,
  signal: SignalId | undefined,
  source: SourceSpan,
  brand: BrandProducer,
): ProducerValue {
  if (signal === undefined) return value;
  if (value.producer.kind === 'constant') {
    outputBindingFailure(
      'A constant combinator output cannot be rebound to another Signal.',
      value,
      source,
    );
  }
  if (value.producer.kind === 'arithmetic') {
    return brand({
      kind: 'producer',
      identity: value.identity,
      producer: { ...value.producer, output: { kind: 'signal', signal } },
    });
  }
  if (value.producer.elseOutputs !== undefined) {
    outputBindingFailure(
      'A decider with an else branch cannot be rebound to one destination Signal.',
      value,
      source,
    );
  }
  if ((value.producer.outputs?.length ?? 1) !== 1) {
    outputBindingFailure(
      'A multi-output decider cannot be rebound to one destination Signal.',
      value,
      source,
    );
  }
  const output = value.producer.output;
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
    return brand({
      kind: 'producer',
      identity: value.identity,
      producer: {
        ...value.producer,
        output: {
          kind: 'signal',
          ...(output.refKind === 'single'
            ? { refKind: 'single' as const, network: output.network }
            : { refKind: 'pair' as const, networks: output.networks }),
          signal,
        },
      },
    });
  }
  if (output.kind === 'each-constant') {
    return brand({
      kind: 'producer',
      identity: value.identity,
      producer: {
        ...value.producer,
        output: { kind: 'signal-constant', signal, value: output.value },
      },
    });
  }
  return outputBindingFailure(
    'Wildcard decider output cannot be rebound to a concrete Signal.',
    value,
    source,
  );
}
