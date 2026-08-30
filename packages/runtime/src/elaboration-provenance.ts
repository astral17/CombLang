export class ElaborationProvenanceFormatter {
  readonly #objects = new WeakMap<object, number>();
  #objectOrdinal = 0;

  format(value: unknown): string {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint' ||
      typeof value === 'symbol'
    ) {
      return String(value);
    }
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    const object = value as object;
    let ordinal = this.#objects.get(object);
    if (ordinal === undefined) {
      ordinal = ++this.#objectOrdinal;
      this.#objects.set(object, ordinal);
    }
    return `${typeof value === 'function' ? 'function' : 'object'}#${ordinal}`;
  }
}
