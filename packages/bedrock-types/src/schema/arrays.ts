import path from 'node:path';
import * as ts from 'typescript-native/ast';
import type { API } from 'typescript-native/sync';
import { typeFingerprint } from './fingerprint.ts';

/** Fold contiguous homogeneous tuple alternatives into a shared length-constrained array. */
export function compactBoundedArrays(api: API, text: string, primitives: string): string {
  let changed = false;

  for (;;) {
    using parsed = api.createSourceFile(path.resolve('arrays.d.ts'), text);
    const edits: { start: number; end: number; text: string }[] = [];

    function visit(node: ts.Node): void {
      if (ts.isUnionTypeNode(node)) {
        const groups = new Map<string, { element: ts.TypeNode; tuples: { node: ts.TypeNode; length: number }[] }>();
        const empty = node.types.filter(type => ts.isTupleTypeNode(type) && !type.elements.length);

        for (const type of node.types) {
          if (!ts.isTupleTypeNode(type) || !type.elements.length || type.elements.some(element => ts.isRestTypeNode(element) || ts.isOptionalTypeNode(element) || ts.isNamedTupleMember(element))) {
            continue;
          }

          const key = typeFingerprint(api, type.elements[0]);

          if (type.elements.some(element => typeFingerprint(api, element) !== key)) {
            continue;
          }

          const group = groups.get(key) ?? { element: type.elements[0], tuples: [] };

          group.tuples.push({ node: type, length: type.elements.length });
          groups.set(key, group);
        }

        const replacements = new Map<ts.TypeNode, string>();
        const removed = new Set<ts.TypeNode>();
        let emptyAvailable = empty;

        for (const group of groups.values()) {
          const tuples = [...emptyAvailable.map(node => ({ node, length: 0 })), ...group.tuples].sort((left, right) => left.length - right.length);
          const lengths = [...new Set(tuples.map(tuple => tuple.length))];

          if (lengths.length < 3 || lengths.some((length, index) => index > 0 && length !== lengths[index - 1] + 1)) {
            continue;
          }

          const first = node.types.find(type => tuples.some(tuple => tuple.node === type))!;

          replacements.set(first, `BoundedArray<${api.printer.printNode(group.element)}, ${lengths[0]}, ${lengths.at(-1)}>`);
          tuples.forEach(tuple => removed.add(tuple.node));
          emptyAvailable = [];
        }

        if (replacements.size) {
          edits.push({
            start: node.getStart(parsed.sourceFile), end: node.end,
            text: node.types.flatMap(type => replacements.has(type) ? [replacements.get(type)!] : removed.has(type) ? [] : [api.printer.printNode(type)]).join(' | '),
          });

          return;
        }
      }

      node.forEachChild(visit);
    }

    visit(parsed.sourceFile);

    if (!edits.length) {
      break;
    }

    changed = true;

    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
  }

  return changed ? `import type { BoundedArray } from '${primitives}';\n` + text : text;
}
