import ts from 'typescript';

/** Normalize relative declaration specifiers without rewriting strings, asset paths or package export keys. */
export function extensionlessImports(text: string): string {
  const source = ts.createSourceFile('declarations.d.ts', text, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];

  const replace = (node: ts.Node | undefined): void => {
    if (!node || !ts.isStringLiteral(node) || !node.text.startsWith('.')) {
      return;
    }

    const specifier = node.text.replace(/(?:\.d)?\.[cm]?[jt]s$/, '');

    if (specifier !== node.text) {
      edits.push({ start: node.getStart(source), end: node.end, text: JSON.stringify(specifier) });
    }
  };

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      replace(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      replace(node.argument.literal);
    } else if (ts.isExternalModuleReference(node)) {
      replace(node.expression);
    } else if (ts.isModuleDeclaration(node)) {
      replace(node.name);
    }

    node.forEachChild(visit);
  }

  visit(source);

  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }

  return text;
}
