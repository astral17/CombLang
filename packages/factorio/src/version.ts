export interface FactorioApiBaseline {
  readonly application: 'factorio';
  readonly gameVersion: string;
  readonly runtimeApiVersion: number;
}

export const FACTORIO_API_BASELINE: FactorioApiBaseline = Object.freeze({
  application: 'factorio',
  gameVersion: '2.1.17',
  runtimeApiVersion: 6,
});
