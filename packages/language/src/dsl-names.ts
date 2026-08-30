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

export const freeDslFunctionNames = Object.freeze([
  'Signal',
  'Network',
  'CC',
  'IF',
  'to',
  'when',
  'pair',
] as const);

/** Free value-space identifiers reserved by the v1 source language. */
export const reservedDslValueNames: ReadonlySet<string> = new Set([
  ...freeDslFunctionNames,
  ...Object.keys(wildcardDslNames),
]);
