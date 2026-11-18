import { format } from 'prettier';
import ts from 'typescript';

/** Remove empty trivia without interpreting comment-like text in strings or examples. */
function cleanComments(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const edits: { start: number; end: number }[] = [];

  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind !== ts.SyntaxKind.MultiLineCommentTrivia && kind !== ts.SyntaxKind.SingleLineCommentTrivia) {
      continue;
    }

    const value = scanner.getTokenText();
    const body = (kind === ts.SyntaxKind.MultiLineCommentTrivia ? value.slice(2, -2) : value.slice(2))
      .split(/\r?\n/).map(line => line.trim().replace(/^\*+\s?/, '')).join('\n').trim();

    if (!body.replace(/^@(remarks|description|summary|example)\s*$/gm, '').trim()) {
      edits.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
    }
  }

  for (const edit of edits.reverse()) {
    text = text.slice(0, edit.start) + text.slice(edit.end);
  }

  return text;
}

/** Keep interface boundaries visible, including inside augmentation modules. */
function interfaceSpacing(text: string): string {
  const source = ts.createSourceFile('generated.d.ts', text, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];

  function visit(node: ts.Node): void {
    if (ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      for (let index = 1; index < node.statements.length; index++) {
        const previous = node.statements[index - 1];
        const current = node.statements[index];

        if (!ts.isInterfaceDeclaration(previous) && !ts.isInterfaceDeclaration(current)) {
          continue;
        }

        const leading = ts.getLeadingCommentRanges(text, current.getFullStart()) ?? [];
        const start = leading[0]?.pos ?? current.getStart(source);
        let whitespace = start;

        while (whitespace > previous.end && /\s/.test(text[whitespace - 1])) {
          whitespace--;
        }

        const gap = text.slice(whitespace, start);

        if (!/\r?\n[\t ]*\r?\n/.test(gap)) {
          const indent = gap.slice(gap.lastIndexOf('\n') + 1).replace(/[^\t ]/g, '');

          edits.push({ start: whitespace, end: start, text: '\n\n' + indent });
        }
      }
    }

    node.forEachChild(visit);
  }

  visit(source);

  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }

  return text;
}

/** Apply the declaration distribution's comment, spacing and indentation policy. */
export function formatDeclarations(text: string): Promise<string> {
  return format(interfaceSpacing(cleanComments(text)), { parser: 'typescript', filepath: 'generated.d.ts', trailingComma: 'none', printWidth: 120 });
}
