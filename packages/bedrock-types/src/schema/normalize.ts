import fs from 'node:fs';
import path from 'node:path';

export type SchemaNode = Record<string, unknown>;
export type Log = (message: string) => void;

export function object(value: unknown): SchemaNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as SchemaNode) : undefined;
}

/** Remove titles that cannot produce valid TypeScript identifiers. */
function sanitizeTitles(value: unknown): void {
  const node = object(value);

  if (Array.isArray(value)) {
    value.forEach(sanitizeTitles);

    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  if (typeof node.title === 'string' && !/^[A-Za-z_$]/.test(node.title.replace(/[^A-Za-z0-9_$]/g, ''))) {
    delete node.title;
  }

  for (const value of Object.values(node)) {
    sanitizeTitles(value);
  }
}

/** Types json-schema-to-typescript can write inline without losing anything. */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * json-schema-to-typescript hoists every subschema that carries a `title` into
 * its own named type, so a plain `{ "title": "Value", "type": "number" }`
 * property compiles to `export type Value15 = number` with the interface
 * reading `value?: Value15` — a deduplicated name that says nothing, and the
 * property's own description parked on the alias rather than on the property.
 * There are 2500-odd of those across the package.
 *
 * Dropping the title inlines the type and moves the doc comment onto the
 * property, which is where the IDE shows it on hover. Titles on `enum`/`const`
 * nodes stay: those name real unions (`SurfaceBuilderType`, …) worth referring
 * to, and inlining them would repeat the whole union at every use site.
 * Nodes relaxed to `unknown` receive the same treatment after normalization.
 */
function normalizeCompilerAnnotations(value: unknown): void {
  const node = object(value);

  if (Array.isArray(value)) {
    value.forEach(normalizeCompilerAnnotations);

    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  for (const value of Object.values(node)) {
    normalizeCompilerAnnotations(value);
  }

  if (node.type === 'array' && typeof node.default === 'string') {
    // The compiler infers a type from the default, even when the schema declares one.
    const serialized = node.default;

    delete node.default;

    try {
      const parsed: unknown = JSON.parse(serialized);

      if (Array.isArray(parsed)) {
        node.default = parsed;
      }
    } catch {
      // Invalid default annotations have no effect on the shape.
    }
  }

  if (typeof node.title !== 'string') {
    return;
  }

  const scalar = typeof node.type === 'string' && SCALAR_TYPES.has(node.type);

  if (!scalar && node.tsType !== 'unknown') {
    return;
  }

  if (node.enum !== undefined || node.const !== undefined) {
    return;
  }

  delete node.title;
}

/** Keys that mean a node actually describes a shape. */
const SHAPE_KEYS = [
  'properties',
  'patternProperties',
  'additionalProperties',
  'required',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  '$ref',
  'enum',
  'const',
  'items',
];

/** Scalar and array constraints cannot describe an object value. */
const SCALAR_ONLY_KEYS = ['minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems'];

/** Preserve unknown shapes without inventing a structural object contract. */
function relaxShapelessObjects(value: unknown): void {
  const node = object(value);

  if (Array.isArray(value)) {
    value.forEach(relaxShapelessObjects);

    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  for (const value of Object.values(node)) {
    relaxShapelessObjects(value);
  }

  if (node.type !== 'object' || node.tsType) {
    return;
  }

  const shapeless = !SHAPE_KEYS.some(k => node[k] !== undefined);
  const contradictory = SCALAR_ONLY_KEYS.some(k => node[k] !== undefined);

  if (shapeless || contradictory) {
    node.tsType = 'unknown';
  }
}

/** An unresolved local reference supplies no usable shape; retain the category with an unknown value. */
function relaxMissingReferences(value: unknown, schemaFile: string, missing: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach(child => relaxMissingReferences(child, schemaFile, missing));

    return;
  }

  const node = object(value);

  if (!node) {
    return;
  }

  if (typeof node.$ref === 'string') {
    const reference = node.$ref.split('#')[0];
    const target = path.resolve(path.dirname(schemaFile), decodeURIComponent(reference));

    if (reference && !/^[a-z]+:/i.test(reference) && !fs.existsSync(target)) {
      missing.add(target);
      node.tsType = 'unknown';
      delete node.$ref;
    }
  }

  Object.values(node).forEach(child => relaxMissingReferences(child, schemaFile, missing));
}

/** Normalize referenced definitions as well as document roots in the owned source copy. */
export function normalizeSchemaTree(schemasRoot: string, log: Log): void {
  let count = 0;
  const missing = new Set<string>();

  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);

      if (item.isDirectory()) {
        walk(full);
      } else if (item.name.endsWith('.json')) {
        const schema = JSON.parse(fs.readFileSync(full, 'utf8'));

        sanitizeTitles(schema);
        relaxShapelessObjects(schema);
        relaxMissingReferences(schema, full, missing);
        normalizeCompilerAnnotations(schema);
        fs.writeFileSync(full, JSON.stringify(schema), 'utf8');
        count++;
      }
    }
  };

  walk(schemasRoot);
  log(`✅ normalized ${count} schema files`);

  if (missing.size) {
    log(`Using unknown for ${missing.size} missing local schema references`);
  }
}
