import path from 'node:path';
import { API, type Checker } from 'typescript-native/sync';
import { createFileSystem } from 'typescript-native/fs';
import { ScriptKind, ScriptTarget, SyntaxKind, type Node, type SourceFile, type TypeAssertion } from 'typescript-native/ast';

export * from 'typescript-native/ast';
export { SymbolFlags, type Symbol } from 'typescript-native/sync';

export function isTypeAssertionExpression(node: Node): node is TypeAssertion {
  return node.kind === SyntaxKind.TypeAssertionExpression;
}

/** Traverse the native syntax tree without materializing a second AST. */
export function forEachChild<T>(node: Node, visit: (child: Node) => T): T | undefined {
  return node.forEachChild(visit);
}

/** A parsed source and the native process/lease that own its nodes. */
export function parseSource(name: string, source: string, scriptKind = ScriptKind.TSX): { file: SourceFile; [Symbol.dispose](): void } {
  const api = new API();

  try {
    const lease = api.createSourceFile(path.resolve(name), source, { scriptKind });

    return { file: lease.sourceFile, [Symbol.dispose]() {
      try {
        lease.dispose();
      } finally {
        api.close();
      }
    } };
  } catch (error) {
    api.close();
    throw error;
  }
}

/** Isolated semantic analysis over an in-memory file; disposal releases all native resources. */
export function analyzeSource(name: string, source: string): { file: SourceFile; checker: Checker; [Symbol.dispose](): void } {
  const api = new API();

  try {
    const fileName = path.resolve(name);
    const snapshot = api.createSnapshot({
      fileSystem: createFileSystem([[fileName, source]]),
      createPrograms: [{ rootFiles: [fileName], compilerOptions: { noLib: true, noResolve: true, allowJs: true, target: ScriptTarget.Latest } }],
    });
    const program = snapshot.operation.createdPrograms?.[0];
    const file = program?.getSourceFile(fileName);

    if (!file || !program) {
      snapshot.dispose();
      throw new Error(`TypeScript did not load ${fileName}`);
    }

    return { file, checker: program.getProject().checker, [Symbol.dispose]() {
      try {
        snapshot.dispose();
      } finally {
        api.close();
      }
    } };
  } catch (error) {
    api.close();
    throw error;
  }
}
