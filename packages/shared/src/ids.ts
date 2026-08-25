declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type SourceFileId = Brand<string, 'SourceFileId'>;
export type NetworkId = Brand<string, 'NetworkId'>;
export type ProducerId = Brand<string, 'ProducerId'>;
export type DeviceId = Brand<string, 'DeviceId'>;

export type StableId<Namespace extends string> = Brand<
  `${Namespace}:${number}`,
  `StableId:${Namespace}`
>;

export function normalizeProjectPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized || '<anonymous>';
}

export function sourceFileId(path: string): SourceFileId {
  return `file:${normalizeProjectPath(path)}` as SourceFileId;
}

export class StableIdAllocator<const Namespace extends string> {
  readonly #namespace: Namespace;
  #next: number;

  constructor(namespace: Namespace, first = 1) {
    if (!Number.isSafeInteger(first) || first < 0) {
      throw new RangeError('The first ID must be a non-negative safe integer.');
    }

    this.#namespace = namespace;
    this.#next = first;
  }

  allocate(): StableId<Namespace> {
    const id = `${this.#namespace}:${this.#next}` as StableId<Namespace>;
    this.#next += 1;
    return id;
  }
}
