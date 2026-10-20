import { z } from 'zod';

// JSON Schema keywords kept for the provider (ADR-0027). Others are dropped: strict function
// calling supports only a subset, and the tool registry parses every call with the full Zod
// schema anyway, so a dropped constraint (a length, a refinement) still holds.
const KEPT_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  '$ref',
  '$defs',
]);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A tool's argument schema in the strict form providers accept: every object closed
 * (`z.strictObject`) and every property required (write "not given" as `.nullable()`, never
 * `.optional()` or `.default()`). Throws, naming the path, when the Zod schema does not fit, so
 * a bad tool fails its own unit test rather than a live call.
 */
export function strictToolParameters(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }) as JsonObject;
  if (json['type'] !== 'object')
    throw new Error('strictToolParameters: the root must be an object');
  return clean(json, '$') as JsonObject;
}

function clean(node: unknown, path: string): unknown {
  if (Array.isArray(node))
    return node.map((item, index) => clean(item, `${path}[${String(index)}]`));
  if (!isObject(node)) return node;
  const properties = node['properties'];
  if (isObject(properties) || node['type'] === 'object') {
    if (node['additionalProperties'] !== false) {
      throw new Error(`strictToolParameters: ${path} must be closed (use z.strictObject)`);
    }
    const required = new Set(Array.isArray(node['required']) ? node['required'] : []);
    const missing = Object.keys(isObject(properties) ? properties : {}).filter(
      (key) => !required.has(key),
    );
    if (missing.length > 0) {
      throw new Error(
        `strictToolParameters: ${path} has optional ${missing.join(', ')} (use .nullable())`,
      );
    }
  }
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (!KEPT_KEYWORDS.has(key)) continue;
    if ((key === 'properties' || key === '$defs') && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, clean(child, `${path}.${name}`)]),
      );
    } else if (key === 'items' || key === 'anyOf') {
      out[key] = clean(value, `${path}.${key}`);
    } else {
      out[key] = value;
    }
  }
  return out;
}
