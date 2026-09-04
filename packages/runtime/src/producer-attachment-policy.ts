import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { NetworkValue, ProducerValue } from './elaboration-values.js';

export interface ProducerAttachmentPolicyContext {
  readonly previousAttachment: SourceSpan | undefined;
  assertWritable(network: NetworkValue): void;
}

/** Validates one physical output connector before a plan descriptor is emitted. */
export function validateProducerAttachment(
  networks: readonly NetworkValue[],
  producer: ProducerValue,
  source: SourceSpan,
  context: ProducerAttachmentPolicyContext,
): void {
  if (networks.length === 0) {
    throw new ElaborationExecutionError(
      'A producer attachment requires at least one Network destination.',
      source,
      'RT2003',
    );
  }
  const uniqueNames = new Set(networks.map(({ name }) => name));
  if (uniqueNames.size !== networks.length) {
    throw new ElaborationExecutionError(
      'A producer attachment repeats the same Network destination.',
      source,
      'RT2004',
      [...new Map(networks.map((network) => [network.name, network])).values()].map((network) => ({
        message: 'Destination Network was declared here.',
        span: network.declaration,
      })),
    );
  }
  if (networks.length > 2) {
    throw new ElaborationExecutionError(
      'One Factorio output connector can attach to at most two logical Networks.',
      source,
      'RT2005',
      networks.map((network) => ({
        message: `Destination Network ${network.name} was declared here.`,
        span: network.declaration,
      })),
    );
  }
  if (context.previousAttachment !== undefined) {
    throw new ElaborationExecutionError(
      'One Producer handle cannot be attached more than once; use one two-destination attachment for physical fan-out.',
      source,
      'RT2006',
      [
        { message: 'Producer was first attached here.', span: context.previousAttachment },
        { message: 'Physical producer was created here.', span: producer.producer.source },
      ],
    );
  }
  for (const network of networks) context.assertWritable(network);
}
