import ts from 'typescript';

/** Apply field corrections to upstream declarations without dropping unmodified fields or documentation. */
export function declarationEdits(text: string): {
  members: (name: string, properties: Record<string, string | null>) => void;
  replace: (name: string, body: string) => void;
  finish: (names: Record<string, string>, imports: string, extra?: string) => string;
} {
  const file = ts.createSourceFile('upstream.d.ts', text, ts.ScriptTarget.Latest, true);
  const interfaces = new Map(file.statements.filter(ts.isInterfaceDeclaration).map(node => [node.name.text, node]));
  const edits: { start: number; end: number; text: string }[] = [];

  const declaration = (name: string): ts.InterfaceDeclaration => {
    const node = interfaces.get(name);

    if (!node) {
      throw new Error('Missing upstream declaration: ' + name);
    }

    return node;
  };

  return {
    members(name, properties) {
      const node = declaration(name);
      const pending = new Map(Object.entries(properties));

      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name) {
          continue;
        }

        const key = member.name.getText(file);

        if (!pending.has(key)) {
          continue;
        }

        const type = pending.get(key);

        pending.delete(key);
        edits.push({ start: type === null ? member.getFullStart() : member.getStart(file), end: member.end, text: type === null ? '' : `${key}${member.questionToken ? '?' : ''}: ${type};` });
      }

      const extra = [...pending].filter(([, type]) => type !== null).map(([key, type]) => `${key}?: ${type};`);

      if (extra.length) {
        edits.push({ start: node.members.end, end: node.members.end, text: '\n' + extra.join('\n') + '\n' });
      }
    },
    replace(name, body) {
      const node = declaration(name);

      edits.push({ start: node.getStart(file), end: node.end, text: body });
    },
    finish(names, imports, extra = '') {
      for (const edit of edits.sort((left, right) => right.start - left.start)) {
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      }

      text = text.replace(/^import .*jsoncommon.*;\s*$/gm, '').replace('export default interface ', 'export interface ');

      return imports + text.replace(/\b[A-Za-z_$][\w$]*\b/g, name => names[name] ?? name) + extra;
    },
  };
}
