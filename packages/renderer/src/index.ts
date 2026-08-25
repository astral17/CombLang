import type { SourceSpan } from '@comblang/shared';

export interface SceneNode {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly source?: SourceSpan;
}

export interface DiagramScene {
  readonly nodes: readonly SceneNode[];
}
