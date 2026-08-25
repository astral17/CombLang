export type Result<Value, ErrorValue> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: ErrorValue };

export function ok<Value>(value: Value): Result<Value, never> {
  return { ok: true, value };
}

export function err<ErrorValue>(error: ErrorValue): Result<never, ErrorValue> {
  return { ok: false, error };
}

export function mapResult<Value, NextValue, ErrorValue>(
  result: Result<Value, ErrorValue>,
  map: (value: Value) => NextValue,
): Result<NextValue, ErrorValue> {
  return result.ok ? ok(map(result.value)) : result;
}
