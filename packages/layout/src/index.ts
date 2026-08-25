import type { NetworkId, ProducerId } from '@comblang/shared';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface SemanticLayout {
  readonly producers: ReadonlyMap<ProducerId, Point>;
  readonly networkJunctions: ReadonlyMap<NetworkId, readonly Point[]>;
}
