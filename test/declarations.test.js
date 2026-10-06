import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { simplifyDeclarations, formatDeclarations } from '../packages/generator/src/declarations.ts';

function simplify(text) {
  return formatDeclarations(simplifyDeclarations(text, ['Document']));
}

test('small single-use primitives, records, arrays and interfaces inline with field documentation', () => {
  const result = simplify(`
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
  assert.match(result, /mode: \('solid' \| 'transparent'\);/);
});

test('duplicate aliases and interfaces share a canonical shape and retain distinct property descriptions', () => {
  const result = simplify(`
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
  assert.match(result, /Contains members named after each state\.[\s\S]*?second: States1;/);
  assert.match(result, /^ {2}\[k: string\]: number;/m);
});

test('alias chains collapse while complex, recursive, generic and inherited declarations retain their names', () => {
  const result = simplify(`
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

test('rewrites preserve keys, literals, operator precedence and public roots', () => {
  const result = simplify(`
    export interface Entry { id: string; }
    export type Keys = keyof Entry;
    export type ReusedNumber = number;
    export interface Document { keys: Keys[]; Entry: 'Entry'; first: ReusedNumber; second: ReusedNumber; }
  `);
  const source = ts.createSourceFile('test.d.ts', result, ts.ScriptTarget.Latest, true);
  const document = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'Document');
  const keys = document.members.find(node => node.name?.getText(source) === 'keys');

  assert.equal(ts.isArrayTypeNode(keys.type), true);
  assert.equal(ts.isParenthesizedTypeNode(keys.type.elementType), true);
  assert.equal(ts.isTypeOperatorNode(keys.type.elementType.type), true);
  assert.match(result, /Entry: 'Entry';/);
  assert.doesNotMatch(result, /export type ReusedNumber/);
  assert.match(result, /export interface Document/);
});

test('two-space formatting preserves documentation examples and escaped string values', () => {
  const result = formatDeclarations(`
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
