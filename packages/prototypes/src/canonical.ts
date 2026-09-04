/** Locale-free lexicographic UTF-16 code-unit order for persisted prototype data. */
export function compareCanonicalString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
