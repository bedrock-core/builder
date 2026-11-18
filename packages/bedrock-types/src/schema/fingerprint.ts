import * as ts from 'typescript-native/ast';
import { isPropertySignatureDeclaration } from 'typescript-native/ast/is';
import type { API } from 'typescript-native/sync';
import lexical from 'typescript';

/** Compare type structure independently of comments, whitespace and unordered members. */
export function typeFingerprint(api: API, node: ts.Node): string {
  if (ts.isParenthesizedTypeNode(node)) {
    return typeFingerprint(api, node.type);
  }

  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return JSON.stringify([node.kind, node.types.map(type => typeFingerprint(api, type)).sort()]);
  }

  if (ts.isTypeLiteralNode(node)) {
    return JSON.stringify(['object', node.members.map(member => typeFingerprint(api, member)).sort()]);
  }

  if (isPropertySignatureDeclaration(node)) {
    const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)
      ? node.name.text
      : api.printer.printNode(node.name);

    return JSON.stringify([
      'property', name, node.postfixToken?.kind === ts.SyntaxKind.QuestionToken,
      node.modifiers?.map(modifier => modifier.kind).sort(), node.type ? typeFingerprint(api, node.type) : '',
    ]);
  }

  if (ts.isIndexSignatureDeclaration(node)) {
    return JSON.stringify([
      'index', node.modifiers?.map(modifier => modifier.kind).sort(),
      node.parameters.map(parameter => parameter.type ? typeFingerprint(api, parameter.type) : ''),
      node.type ? typeFingerprint(api, node.type) : '',
    ]);
  }

  const scanner = lexical.createScanner(lexical.ScriptTarget.Latest, true, lexical.LanguageVariant.Standard, api.printer.printNode(node));
  const tokens: string[] = [];

  for (let kind = scanner.scan(); kind !== lexical.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens.push(scanner.getTokenText());
  }

  return JSON.stringify(tokens);
}

/** Numeric disambiguators belong to the same role; unrelated semantic names do not. */
export function declarationFamily(name: string, names: ReadonlySet<string> = new Set()): string {
  for (let length = name.length - 1; length > 0 && /\d/.test(name[length]); length--) {
    const prefix = name.slice(0, length);

    if (/\d$/.test(prefix) && names.has(prefix)) {
      return declarationFamily(prefix, names);
    }
  }

  if (/(?:Vector|Vec|Matrix|V|Float|Int|Uint)\d+$/.test(name)) {
    return name;
  }

  return name.replace(/\d+$/, '');
}
