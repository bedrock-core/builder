import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { API } from 'typescript-native/sync';
import { simplifyDeclarations, formatDeclarations } from '../src/schema/declarations.ts';
import { compactBoundedArrays } from '../src/schema/arrays.ts';
import { extensionlessImports } from '../src/schema/imports.ts';

function simplify(text: string): Promise<string> {
  const api = new API();

  try {
    return formatDeclarations(simplifyDeclarations(api, text, ['Document']));
  } finally {
    api.close();
  }
}

test('small single-use primitives, records, arrays and interfaces inline with field documentation', async () => {
  const result = await simplify(`
    /** Available values. */
    export type Values = string[];
    export type Lookup = Record<string, number>;
    /** A small configuration. */
    export interface Options { enabled?: boolean; count: number; }
    export type Mode = 'solid' | 'transparent';
    export interface Document {
      values: Values;
      lookup: Lookup;
      /** Project options. */
      options: Options;
      mode: Mode;
    }
  `);

  assert.doesNotMatch(result, /export (?:type|interface) (?:Values|Lookup|Options|Mode)\b/);
  assert.match(result, /Available values\.[\s\S]*?values: string\[\];/);
  assert.match(result, /lookup: Record<string, number>;/);
  assert.match(result, /Project options\.[\s\S]*?A small configuration\.[\s\S]*?options: \{/);
  assert.match(result, /^ {2}options: \{\n {4}enabled\?: boolean;\n {4}count: number;\n {2}\};/m);
  assert.match(result, /mode: "solid" \| "transparent";/);
});

test('duplicate aliases and interfaces share a canonical shape and retain distinct property descriptions', async () => {
  const result = await simplify(`
    /** Initial state map. */
    export type States1 = ({ [k: string]: number } | { [k: string]: boolean } | { [k: string]: string });
    /** Contains members named after each state. */
    export type States2 = ({ [k: string]: number } | { [k: string]: boolean } | { [k: string]: string });
    export interface Position1 { x: number; y: number; }
    export interface Position2 { x: number; y: number; }
    export interface Document { first: States1; second: States2; start: Position1; end: Position2; }
  `);

  assert.match(result, /export type States1 =/);
  assert.doesNotMatch(result, /\bStates2\b|\bPosition2\b/);
  assert.match(result, /export interface Position1/);
  assert.match(result, /^ {2}\/\*\*\n {3}\* Contains members named after each state\.\n {3}\*\/\n {2}second: States1;/m);
  assert.match(result, /\{\s*\[k: string\]: number;?\s*\}/);
});

test('alias chains collapse while complex, recursive, generic and inherited declarations retain their names', async () => {
  const result = await simplify(`
    export type Element = number;
    export type Items = Element[];
    export type Rows = Items[];
    export interface Complex { a: string; b: string; c: string; d: string; e: string; }
    export interface Recursive { next?: Recursive; }
    export interface Generic<T> { value: T; }
    export interface Base { enabled: boolean; }
    export interface Extended extends Base { name: string; }
    export interface Document { rows: Rows; complex: Complex; recursive: Recursive; generic: Generic<string>; extended: Extended; }
  `);

  assert.doesNotMatch(result, /export type (?:Element|Items|Rows)\b/);
  assert.match(result, /rows: number\[\]\[\];/);
  assert.match(result, /export interface Complex/);
  assert.match(result, /export interface Recursive/);
  assert.match(result, /export interface Generic<T>/);
  assert.match(result, /export interface Base/);
  assert.match(result, /export interface Extended extends Base/);
});

test('rewrites preserve keys, literals, operator precedence and public roots', async () => {
  const result = await simplify(`
    export interface Entry { id: string; }
    export type Keys = keyof Entry;
    export type ReusedNumber = number;
    export interface Document { keys: Keys[]; Entry: 'Entry'; first: ReusedNumber; second: ReusedNumber; }
  `);
  const source = ts.createSourceFile('test.d.ts', result, ts.ScriptTarget.Latest, true);
  const document = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'Document');

  assert.ok(document && ts.isInterfaceDeclaration(document));
  const keys = document.members.find(node => node.name?.getText(source) === 'keys');

  assert.ok(keys && ts.isPropertySignature(keys) && keys.type && ts.isArrayTypeNode(keys.type));
  assert.ok(ts.isParenthesizedTypeNode(keys.type.elementType));
  assert.equal(ts.isTypeOperatorNode(keys.type.elementType.type), true);
  assert.match(result, /Entry: "Entry";/);
  assert.doesNotMatch(result, /export type ReusedNumber/);
  assert.match(result, /export interface Document/);
});

test('two-space formatting preserves documentation examples and escaped string values', async () => {
  const result = await formatDeclarations(`
    /**
     * Example:
     *   export default { value: 'sample' };
     */
    export interface Document {
    nested: {
    value: "line\\n  two spaces";
    };
    }
  `);

  assert.match(result, /^ {2}nested: \{\n {4}value: "line\\n {2}two spaces";\n {2}\};/m);
  assert.match(result, /\* {3}export default \{ value: 'sample' \};/);
});

test('structural duplicate detection preserves semantic roles, optionality and readonly members', async () => {
  const result = await simplify(`
    export interface CollisionBox { origin: number[]; size: number[]; x: number; y: number; z: number; }
    export interface CollisionBox1 { z: number; y: number; x: number; /** Box size. */ size: number[]; origin: number[]; }
    export interface Loop { origin: number[]; size: number[]; x: number; y: number; z: number; }
    export interface State { id?: string; a: number; b: number; c: number; d: number; }
    export interface State1 { id: string; a: number; b: number; c: number; d: number; }
    export interface State2 { readonly id: string; a: number; b: number; c: number; d: number; }
    export type Vec2 = number[];
    export type Vec3 = number[];
    export type Vec31 = number[];
    export interface Document { first: CollisionBox; second: CollisionBox1; before: Loop; after: Loop; optional: State; required: State1; readonly: State2; uv: Vec2; uv2: Vec2; position: Vec3; position2: Vec31; }
  `);

  assert.match(result, /first: CollisionBox;/);
  assert.match(result, /second: CollisionBox;/);
  assert.doesNotMatch(result, /\bCollisionBox1\b/);
  assert.match(result, /before: Loop;/);
  assert.match(result, /after: Loop;/);
  assert.match(result, /optional: State;/);
  assert.match(result, /required: State1;/);
  assert.match(result, /readonly: State2;/);
  assert.match(result, /uv: Vec2;/);
  assert.match(result, /position: Vec3;/);
  assert.match(result, /position2: Vec3;/);
});

test('bounded tuple ranges compact without changing fixed vectors or noncontiguous alternatives', async () => {
  using api = new API();
  const text = `
    export type Box = boolean | [] | [number] | [number, number] | [number, number, number];
    export type Vector = [number, number, number];
    export type Sparse = [] | [number, number];
    export type Mixed = [number, string] | [number, string, boolean];
  `;
  const result = await formatDeclarations(compactBoundedArrays(api, text, '../common/primitives.js'));

  assert.match(result, /Box = boolean \| BoundedArray<number, 0, 3>/);
  assert.match(result, /Vector = \[number, number, number\]/);
  assert.match(result, /Sparse = \[\] \| \[number, number\]/);
  assert.match(result, /Mixed = \[number, string\] \| \[number, string, boolean\]/);
  assert.equal(compactBoundedArrays(api, result, '../common/primitives.js'), result);
});

test('formatting removes empty comments and separates documented and nested interfaces', async () => {
  const result = await formatDeclarations(`
    /** */
    export interface First { example: "/** */"; }
    /**
     * @remarks
     */
    export interface Second { count: number; }
    /** Useful documentation. */
    export interface Third { active: boolean; }
    /** @deprecated */
    export type Old = string;
    declare module 'registry' {
      interface One { first: string; }
      interface Two { second: string; }
    }
  `);

  assert.doesNotMatch(result, /@remarks/);
  assert.match(result, /example: "\/\*\* \*\/"/);
  assert.match(result, /\}\n\nexport interface Second/);
  assert.match(result, /\}\n\n\/\*\* Useful documentation\. \*\/\nexport interface Third/);
  assert.match(result, /@deprecated/);
  assert.match(result, /\n {2}\}\n\n {2}interface Two/);
});

test('declaration specifiers omit code extensions while preserving asset strings and external package keys', () => {
  const result = extensionlessImports(`
    import type { Geometry } from './geometry.js';
    import type { Other } from '../other.d.ts';
    export type * from './parts.mjs';
    export type Value = import('./value.ts').Value;
    import legacy = require('./legacy.cjs');
    declare module './registry.js' { interface Entry { value: string; } }
    import type { Data } from 'external-package/data.js';
    import type schema from './schema.json';
    export type File = 'textures/entity/example.png' | './geometry.js';
    /** Example: import type { Geometry } from './geometry.js'; */
  `);

  assert.match(result, /from "\.\/geometry"/);
  assert.match(result, /from "\.\.\/other"/);
  assert.match(result, /from "\.\/parts"/);
  assert.match(result, /import\("\.\/value"\)/);
  assert.match(result, /require\("\.\/legacy"\)/);
  assert.match(result, /module "\.\/registry"/);
  assert.match(result, /external-package\/data\.js/);
  assert.match(result, /from '\.\/schema\.json'/);
  assert.match(result, /'textures\/entity\/example\.png' \| '\.\/geometry\.js'/);
  assert.match(result, /Example: import type \{ Geometry \} from '\.\/geometry\.js'/);
});
