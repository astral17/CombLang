import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { NetworkValue } from './elaboration-values.js';

export interface CombinatorAttachmentPolicyContext {
  assertWritable(network: NetworkValue): void;
}

/** Validates one physical output connector before a plan descriptor is emitted. */
export function validateCombinatorAttachment(
  networks: readonly NetworkValue[],
  source: SourceSpan,
  context: CombinatorAttachmentPolicyContext,
): void {
  if (networks.length === 0) {
    throw new ElaborationExecutionError(
      'A combinator output connection requires at least one Network destination.',
      source,
      'RT2003',
    );
  }
  const uniqueNames = new Set(networks.map(({ name }) => name));
  if (uniqueNames.size !== networks.length) {
    throw new ElaborationExecutionError(
      'A combinator output connection repeats the same Network destination.',
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
  for (const network of networks) context.assertWritable(network);
}
