import type { ArgMatcher } from './case.js';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Where `actual` differs from `expected` (empty when it matches), as readable paths for the
 * eval report. Objects match partially; arrays element by element and of the same length.
 */
export function mismatches(actual: unknown, expected: ArgMatcher, path = '$'): string[] {
  if (isPlainObject(expected)) {
    const keys = Object.keys(expected);
    if (keys.length === 1 && expected['$any'] === true) {
      return actual === undefined ? [`${path} is missing`] : [];
    }
    const regex = expected['$regex'];
    if (typeof regex === 'string' && keys.every((key) => key === '$regex' || key === 'flags')) {
      const flags = typeof expected['flags'] === 'string' ? expected['flags'] : 'i';
      return typeof actual === 'string' && new RegExp(regex, flags).test(actual)
        ? []
        : [`${path} ${JSON.stringify(actual)} does not match /${regex}/${flags}`];
    }
    if (!isPlainObject(actual)) return [`${path} is ${JSON.stringify(actual)}, not an object`];
    return keys.flatMap((key) => {
      const child = expected[key];
      return child === undefined ? [] : mismatches(actual[key], child, `${path}.${key}`);
    });
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return [`${path} is ${JSON.stringify(actual)}, not ${String(expected.length)} items`];
    }
    return expected.flatMap((child, index) =>
      mismatches(actual[index], child, `${path}[${String(index)}]`),
    );
  }
  return actual === expected
    ? []
    : [`${path} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`];
}
