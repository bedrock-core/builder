import { glob, readFile, stat } from 'node:fs/promises';
import ts from 'typescript';
import path from 'node:path';
import type { BuildContext } from '@bedrock-core/builder-plugin';

export interface TemplateSelection {
  include?: string | string[];
  exclude?: string | string[];
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}

function within(root: string, file: string): boolean {
  const value = path.relative(root, file);

  return value !== '' && value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value);
}

/** Share template discovery between automatic detection and generator execution. */
export async function templateFiles(context: BuildContext, settings: TemplateSelection = {}): Promise<string[]> {
  const packPaths = Object.values(context.packs);
  const exclude = [
    '**/*.d.{ts,mts,cts}',
    ...packPaths.map(directory => `${relative(context.stagedRoot, directory)}/scripts/**`),
    ...packPaths.map(directory => `${relative(context.stagedRoot, directory)}/i18n/**`),
    ...packPaths.map(directory => `${relative(context.stagedRoot, directory)}/guides/**`),
    ...(context.inputDirectories ?? []).map(directory => `${relative(context.stagedRoot, directory)}/**`),
    ...([settings.exclude ?? []].flat()),
  ];

  const include = settings.include ?? packPaths.map(directory => `${relative(context.stagedRoot, directory)}/**/*.ts`);
  const files = new Set<string>();

  for await (const name of glob(include, { cwd: context.stagedRoot, exclude })) {
    const file = path.resolve(context.stagedRoot, name);

    if (!(await stat(file)).isFile()) {
      continue;
    }

    if (!packPaths.some(directory => within(directory, file))) {
      throw new Error(`Generator templates must be inside configured packs: ${name}`);
    }

    if (settings.include === undefined) {
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const producesOutput = source.statements.some(statement =>
        (ts.isExportAssignment(statement) && !statement.isExportEquals)
        || ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
          && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))
        || (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
          && statement.exportClause.elements.some(element => element.name.text === 'default')),
      );

      if (!producesOutput) {
        continue;
      }
    }

    files.add(file);
  }

  return [...files].sort();
}
