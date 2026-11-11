import { format } from 'prettier';
import * as ts from 'typescript-native/ast';
import { isPropertySignatureDeclaration } from 'typescript-native/ast/is';
import { createTypeLiteralNode } from 'typescript-native/ast/factory';
import { getLeadingCommentRanges, type CommentRange } from 'typescript-native/ast/scanner';
import type { API } from 'typescript-native/sync';
import path from 'node:path';

type Declaration = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;

interface NamedType {
  declaration: Declaration;
  type: ts.TypeNode;
  dependencies: Set<string>;
}

interface Reference {
  node: ts.TypeReferenceNode;
  name: string;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const PRIMITIVES = new Set([
  ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.SymbolKeyword, ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.UndefinedKeyword, ts.SyntaxKind.VoidKeyword,
]);

function references(node: ts.Node): Reference[] {
  const result: Reference[] = [];

  function visit(node: ts.Node): void {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      result.push({ node, name: node.typeName.text });
    }

    node.forEachChild(visit);
  }

  visit(node);

  return result;
}

function declarations(source: ts.SourceFile): Map<string, NamedType> {
  const result = new Map<string, NamedType>();

  for (const node of source.statements) {
    if ((!ts.isTypeAliasDeclaration(node) && !ts.isInterfaceDeclaration(node)) || node.typeParameters?.length) {
      continue;
    }

    if (ts.isInterfaceDeclaration(node) && node.heritageClauses?.length) {
      continue;
    }

    const type = ts.isTypeAliasDeclaration(node) ? node.type : createTypeLiteralNode(node.members);

    result.set(node.name.text, { declaration: node, type, dependencies: new Set(references(type).map(reference => reference.name)) });
  }

  return result;
}

function recursiveTypes(types: Map<string, NamedType>): Set<string> {
  const recursive = new Set<string>();
  const visited = new Set<string>();
  const active: string[] = [];

  function visit(name: string): void {
    const index = active.indexOf(name);

    if (index >= 0) {
      active.slice(index).forEach(name => recursive.add(name));

      return;
    }

    if (visited.has(name)) {
      return;
    }

    visited.add(name);
    active.push(name);

    for (const dependency of types.get(name)?.dependencies ?? []) {
      visit(dependency);
    }

    active.pop();
  }

  types.forEach((_type, name) => visit(name));

  return recursive;
}

/** Limit nesting, member count and total size so inlining stays readable. */
function size(type: ts.TypeNode, depth = 0): number {
  if (ts.isParenthesizedTypeNode(type)) {
    return size(type.type, depth);
  }

  if (depth > 3) {
    return Infinity;
  }

  if (PRIMITIVES.has(type.kind) || ts.isLiteralTypeNode(type)) {
    return 1;
  }

  if (ts.isTypeReferenceNode(type)) {
    if (!type.typeArguments?.length) {
      return 1;
    }

    if (ts.isIdentifier(type.typeName) && ['Record', 'Array', 'ReadonlyArray'].includes(type.typeName.text)) {
      return 1 + type.typeArguments.reduce((total, argument) => total + size(argument, depth + 1), 0);
    }
  }

  if (ts.isArrayTypeNode(type) || ts.isOptionalTypeNode(type) || ts.isRestTypeNode(type) || ts.isTypeOperatorNode(type)) {
    const child = ts.isArrayTypeNode(type) ? type.elementType : type.type;

    return 1 + size(child, depth + 1);
  }

  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type) || ts.isTupleTypeNode(type)) {
    const children = ts.isTupleTypeNode(type) ? type.elements : type.types;

    return children.length <= 4 ? 1 + children.reduce((total, child) => total + size(child, depth + 1), 0) : Infinity;
  }

  if (ts.isTypeLiteralNode(type) && type.members.length <= 4) {
    let total = 1;

    for (const member of type.members) {
      if ((!isPropertySignatureDeclaration(member) && !ts.isIndexSignatureDeclaration(member)) || !member.type) {
        return Infinity;
      }

      total += 1 + size(member.type, depth + 1);

      if (ts.isIndexSignatureDeclaration(member)) {
        total += member.parameters.reduce((count, parameter) => count + (parameter.type ? size(parameter.type, depth + 1) : Infinity), 0);
      }
    }

    return total;
  }

  return Infinity;
}

function primitive(type: ts.TypeNode): boolean {
  return PRIMITIVES.has(type.kind) || (ts.isParenthesizedTypeNode(type) && primitive(type.type));
}

function comments(node: ts.Node, source: ts.SourceFile): CommentRange[] {
  return (getLeadingCommentRanges(source.text, node.getFullStart()) ?? [])
    .filter(range => source.text.slice(range.pos, range.pos + 3) === '/**');
}

function commentText(range: CommentRange, source: ts.SourceFile): string {
  return source.text.slice(range.pos + 3, range.end - 2).split('\n')
    .map(line => line.trim().replace(/^\* ?/, '')).join('\n').trim();
}

function commentOwner(reference: ts.Node): ts.Node | undefined {
  let node = reference.parent;

  while (node && !ts.isSourceFile(node)) {
    if (isPropertySignatureDeclaration(node) || ts.isIndexSignatureDeclaration(node)
      || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      return node;
    }

    node = node.parent;
  }

  return undefined;
}

function apply(text: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }

  return text;
}

/** Remove redundant declarations using syntax positions, leaving keys and string values intact. */
export function simplifyDeclarations(api: API, text: string, publicNames: readonly string[]): string {
  const retained = new Set(publicNames);

  while (true) {
    using parsed = api.createSourceFile(path.resolve('generated.d.ts'), text);
    const source = parsed.sourceFile;
    const types = declarations(source);
    const uses = references(source);
    const recursive = recursiveTypes(types);
    const blocked = new Set(retained);

    function protect(node: ts.Node): void {
      if (ts.isTypeReferenceNode(node) && ts.isHeritageClause(node.parent) && ts.isIdentifier(node.typeName)) {
        blocked.add(node.typeName.text);
      }

      if (ts.isExportSpecifier(node)) {
        blocked.add((node.propertyName ?? node.name).text);
      }

      node.forEachChild(protect);
    }

    protect(source);
    const shapes = new Map<string, string>();
    const replacements = new Map<string, { text: string; renamed: boolean }>();

    // Public roots take precedence when a helper has the same shape.
    const names = [...types.keys()].sort((a, b) => Number(blocked.has(b)) - Number(blocked.has(a)));

    for (const name of names) {
      const type = types.get(name)!;

      if (recursive.has(name)) {
        continue;
      }

      const shape = api.printer.printNode(type.type);
      const existing = shapes.get(shape);

      if (existing && !blocked.has(name)) {
        replacements.set(name, { text: existing, renamed: true });
      } else {
        shapes.set(shape, name);
      }
    }

    if (!replacements.size) {
      const counts = new Map<string, number>();

      uses.forEach(reference => counts.set(reference.name, (counts.get(reference.name) ?? 0) + 1));
      const small = new Set([...types].filter(([name, type]) => !blocked.has(name) && !recursive.has(name)
        && (counts.get(name) === 1 || primitive(type.type)) && size(type.type) <= 24).map(([name]) => name));

      for (const name of small) {
        const type = types.get(name)!;

        // Inline leaves together; their parents are reconsidered on the next pass.
        if ([...type.dependencies].some(dependency => small.has(dependency))) {
          continue;
        }

        const body = api.printer.printNode(type.type);

        const parentheses = ts.isUnionTypeNode(type.type) || ts.isIntersectionTypeNode(type.type) || ts.isTypeOperatorNode(type.type);

        replacements.set(name, { text: parentheses ? `(${body})` : body, renamed: false });
      }
    }

    if (!replacements.size) {
      return text;
    }

    const removed = [...replacements.keys()].map(name => types.get(name)!.declaration);
    const edits: Edit[] = removed.map(node => ({ start: node.getFullStart(), end: node.end, text: '' }));
    const documentation = new Map<ts.Node, Set<string>>();

    for (const reference of uses) {
      const replacement = replacements.get(reference.name);

      if (!replacement) {
        continue;
      }

      const node = replacement.renamed ? reference.node.typeName : reference.node;

      edits.push({ start: node.getStart(source), end: node.end, text: replacement.text });
      const owner = commentOwner(reference.node);
      const declaration = types.get(reference.name)!.declaration;

      if (owner) {
        const docs = documentation.get(owner) ?? new Set<string>();

        comments(declaration, source).forEach(range => docs.add(commentText(range, source)));
        documentation.set(owner, docs);
      }
    }

    for (const [owner, extra] of documentation) {
      if (!extra.size) {
        continue;
      }

      const original = comments(owner, source);
      const sections = new Set([...original.map(range => commentText(range, source)), ...extra]);
      const body = [...sections].join('\n\n').split('\n').map(line => ` *${line ? ` ${line}` : ''}`).join('\n');
      const last = original.at(-1);
      const start = last?.pos ?? owner.getStart(source);
      const newline = !last && !source.text.slice(owner.getFullStart(), start).includes('\n') ? '\n' : '';

      edits.push({ start, end: last?.end ?? start, text: `${newline}/**\n${body}\n */${last ? '' : '\n'}` });
    }

    const removals = edits.slice(0, removed.length);

    text = apply(text, edits.filter(edit => removals.includes(edit)
      || !removals.some(removal => edit.start >= removal.start && edit.end <= removal.end)));
  }
}

/** Format generated and vendored declarations with the schema compiler's formatter. */
export function formatDeclarations(text: string): Promise<string> {
  return format(text, { parser: 'typescript', filepath: 'generated.d.ts', trailingComma: 'none', printWidth: 120 });
}
