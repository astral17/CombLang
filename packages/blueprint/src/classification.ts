import { BlueprintDocumentError } from './errors.js';
import { LosslessJsonNumber, LosslessJsonObject, type LosslessJsonValue } from './document.js';

export type BlueprintNativeRoot =
  'blueprint' | 'blueprint_book' | 'upgrade_planner' | 'deconstruction_planner';

export type OpaqueBlueprintRoot = Exclude<BlueprintNativeRoot, 'blueprint'>;

export interface BlueprintSemanticHeader {
  readonly item: string | undefined;
  readonly label: string | undefined;
  readonly version: number | undefined;
  readonly hasEntities: boolean;
  readonly hasWires: boolean;
}

export interface BlueprintDocumentProjection {
  readonly kind: 'blueprint';
  readonly root: 'blueprint';
  /** The complete immutable native document, including fields outside this projection. */
  readonly document: LosslessJsonObject;
  readonly semantic: BlueprintSemanticHeader;
}

export interface OpaqueBlueprintDocument {
  readonly kind: 'opaque';
  readonly root: OpaqueBlueprintRoot;
  /** The complete immutable native document; opaque roots are not blueprint-projectable. */
  readonly document: LosslessJsonObject;
  readonly semanticProjectionAvailable: false;
}

export type BlueprintDocumentClassification = BlueprintDocumentProjection | OpaqueBlueprintDocument;

const opaqueRoots = new Set<OpaqueBlueprintRoot>([
  'blueprint_book',
  'upgrade_planner',
  'deconstruction_planner',
]);

function classificationError(
  code: 'BPD1007' | 'BPD1008',
  message: string,
  path: string,
): BlueprintDocumentError {
  return new BlueprintDocumentError(code, message, { path });
}

function keyPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*(?![\s\S])/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function optionalString(root: LosslessJsonObject, key: string): string | undefined {
  const value = root.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw classificationError(
      'BPD1008',
      `Blueprint header field ${key} must be a string when present.`,
      keyPath('$.blueprint', key),
    );
  }
  return value;
}

function optionalSafeVersion(root: LosslessJsonObject): number | undefined {
  const value = root.get('version');
  if (value === undefined) return undefined;
  if (!(value instanceof LosslessJsonNumber)) {
    throw classificationError(
      'BPD1008',
      'Blueprint version must be an exact safe integer when present.',
      '$.blueprint.version',
    );
  }
  const number = value.toNumberIfExact();
  if (number === undefined || !Number.isSafeInteger(number)) {
    throw classificationError(
      'BPD1008',
      'Blueprint version must be an exact safe integer when present.',
      '$.blueprint.version',
    );
  }
  return number;
}

function isObjectNode(value: LosslessJsonValue): value is LosslessJsonObject {
  return (
    value instanceof LosslessJsonObject &&
    Object.getPrototypeOf(value) === LosslessJsonObject.prototype
  );
}

/** Classifies one supported native root while retaining the complete lossless tree. */
export function classifyBlueprintDocument(
  nativeDocument: LosslessJsonValue,
): BlueprintDocumentClassification {
  if (!isObjectNode(nativeDocument)) {
    throw classificationError('BPD1007', 'Native document root must be an object.', '$');
  }
  if (nativeDocument.entries.length !== 1) {
    throw classificationError(
      'BPD1007',
      'Native document must contain exactly one supported top-level root.',
      '$',
    );
  }

  const entry = nativeDocument.entries[0];
  if (entry === undefined) {
    throw classificationError('BPD1007', 'Native document root is missing.', '$');
  }
  const [rootName, rootValue] = entry;
  const rootPath = keyPath('$', rootName);
  if (rootName !== 'blueprint' && !opaqueRoots.has(rootName as OpaqueBlueprintRoot)) {
    throw classificationError(
      'BPD1007',
      `Unsupported native document root: ${rootName}.`,
      rootPath,
    );
  }
  if (!isObjectNode(rootValue)) {
    throw classificationError(
      'BPD1007',
      `Native root ${rootName} must contain an object.`,
      rootPath,
    );
  }

  if (rootName !== 'blueprint') {
    return Object.freeze({
      kind: 'opaque',
      root: rootName as OpaqueBlueprintRoot,
      document: nativeDocument,
      semanticProjectionAvailable: false,
    });
  }

  const semantic = Object.freeze({
    item: optionalString(rootValue, 'item'),
    label: optionalString(rootValue, 'label'),
    version: optionalSafeVersion(rootValue),
    hasEntities: rootValue.entries.some(([key]) => key === 'entities'),
    hasWires: rootValue.entries.some(([key]) => key === 'wires'),
  });
  return Object.freeze({
    kind: 'blueprint',
    root: 'blueprint',
    document: nativeDocument,
    semantic,
  });
}
