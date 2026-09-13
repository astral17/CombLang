export const wildcardDslNames = Object.freeze({
  Each: 'each',
  EACH: 'each',
  Anything: 'anything',
  Any: 'anything',
  ANYTHING: 'anything',
  ANY: 'anything',
  Everything: 'everything',
  All: 'everything',
  EVERYTHING: 'everything',
  ALL: 'everything',
} as const);

export type WildcardDslName = keyof typeof wildcardDslNames;

/** Closed Entity-family constructor/type pairs supported by the source DSL. */
export const entityFamilyDslNames = Object.freeze({
  Lamp: 'lamp',
  Roboport: 'roboport',
  Constant: 'constant-combinator',
} as const);

export type EntityFamilyDslName = keyof typeof entityFamilyDslNames;

export const freeDslFunctionNames = Object.freeze([
  'Signal',
  'Entity',
  ...Object.keys(entityFamilyDslNames),
  'NativeCondition',
  'Network',
  'CC',
  'IF',
  'to',
  'when',
  'pair',
  'join',
] as const);

/** Free value-space identifiers reserved by the v1 source language. */
export const reservedDslValueNames: ReadonlySet<string> = new Set([
  ...freeDslFunctionNames,
  ...Object.keys(wildcardDslNames),
  'prototypes',
]);
