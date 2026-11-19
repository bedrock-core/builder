import path from 'node:path';
import { ScriptKind, ScriptTarget, isInterfaceDeclaration, isPropertySignatureDeclaration, isStringLiteral } from 'typescript-native/ast';
import { computeLineStarts } from 'typescript-native/ast/scanner';
import { createFileSystemLayer } from 'typescript-native/fs';
import { ModuleKind, ModuleResolutionKind, type API, type Diagnostic, type RawCompilerOptions } from 'typescript-native/sync';

const exactCategories: Record<string, string> = {
  'bp/functions/tick.json': 'bp/functions/tick',
  'rp/blocks.json': 'rp/textures/blocks_resource',
  'rp/sounds.json': 'rp/sounds/events',
  'rp/sounds/sound_definitions.json': 'rp/sounds',
  'rp/sounds/music_definitions.json': 'rp/sounds/music_definitions',
  'rp/textures/terrain_texture.json': 'rp/textures/terrain_texture',
  'rp/textures/item_texture.json': 'rp/textures/item_texture',
  'rp/textures/texture_list.json': 'rp/textures/texture_list',
  'rp/textures/flipbook_textures.json': 'rp/textures/flipbook_textures',
};
const deferred = new Set(['lighting', 'color_grading', 'atmospherics', 'pbr', 'point_lights', 'shadows', 'water']);

export function documentCategory(kind: 'behavior' | 'resource', file: string): string {
  const folder = file.split('/')[0];
  const prefix = kind === 'behavior' ? 'bp' : 'rp';

  if (kind === 'behavior' && folder === 'shapes') {
    return 'bp/voxel_shapes';
  }

  if (kind === 'resource' && file.endsWith('.texture_set.json')) {
    return 'rp/textures/texture_set';
  }

  if (kind === 'resource' && deferred.has(folder)) {
    return 'rp/deferred_rendering/' + folder;
  }

  return exactCategories[prefix + '/' + file] ?? prefix + '/' + folder;
}

export function declaredCategories(api: API, file: string): ReadonlySet<string> {
  using declaration = api.createSourceFileFromFile(file, { scriptKind: ScriptKind.TS });
  const map = declaration.sourceFile.statements.find(node => isInterfaceDeclaration(node) && node.name.text === 'DocumentTypes');

  if (!map || !isInterfaceDeclaration(map)) {
    throw new Error('Missing public DocumentTypes declarations in ' + file);
  }

  return new Set(map.members.flatMap(member =>
    isPropertySignatureDeclaration(member) && isStringLiteral(member.name) ? [member.name.text] : [],
  ));
}

export interface DocumentInput {
  category: string;
  literal: string;
}

export interface TypeFinding {
  code: number;
  message: string;
  offset: number;
}

export function documentLiteral(value: unknown): string {
  // Native diagnostics include source lines. Indentation keeps large documents from repeating in each diagnostic.
  return JSON.stringify(value, null, 2).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

function diagnosticMessage(diagnostic: Diagnostic, depth = 0): string {
  return diagnostic.text + (diagnostic.messageChain ?? []).map(child => '\n' + '  '.repeat(depth + 1) + diagnosticMessage(child, depth + 1)).join('');
}

/** Type-check fresh JSON literals without executing their contents. */
export function createDocumentChecker(
  api: API,
  distribution: string,
  { additionalRoots = [], documentTypes }: { additionalRoots?: readonly string[]; documentTypes?: string } = {},
) {
  const compilerOptions: RawCompilerOptions = {
    strict: true,
    noEmit: true,
    module: ModuleKind.NodeNext,
    moduleResolution: ModuleResolutionKind.NodeNext,
    target: ScriptTarget.ES2023,
    types: [],
    skipLibCheck: additionalRoots.length === 0,
  };
  const file = path.join(distribution, 'bedrock-document-check.cts');
  const rootFiles = [file, ...additionalRoots];
  const declarations = documentTypes !== undefined
    ? [[path.join(distribution, 'audit-documents.d.ts'), documentTypes] as const]
    : [];
  const typeModule = declarations.length ? './audit-documents' : './documents';

  return (pending: readonly DocumentInput[], signal?: AbortSignal): TypeFinding[][] => {
    const findings: TypeFinding[][] = pending.map(() => []);
    let start = 0;

    while (start < pending.length) {
      signal?.throwIfAborted();
      const statements = [`import type { DocumentTypes } from '${typeModule}';\n`];
      const ranges: { start: number; literalStart: number }[] = [];
      const offset = start;
      let size = statements[0].length;

      while (start < pending.length && ranges.length < 256 && size < 2 * 1024 * 1024) {
        const { category, literal } = pending[start];
        const prefix = `export const document${start}: DocumentTypes[${JSON.stringify(category)}] = `;
        const statement = prefix + literal + ';\n';

        ranges.push({ start: size, literalStart: size + prefix.length });
        statements.push(statement);
        size += statement.length;
        start++;
      }

      const source = statements.join('');
      const lineStarts = computeLineStarts(source);

      using snapshot = api.createSnapshot({
        fileSystem: createFileSystemLayer([[file, source], ...declarations]),
        createPrograms: [{ rootFiles, compilerOptions }],
      });
      using program = snapshot.operation.createdPrograms[0];
      const diagnostics = [
        ...program.getProgramDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...program.getSyntacticDiagnostics(),
        ...program.getSemanticDiagnostics(),
      ];

      for (const diagnostic of diagnostics) {
        const { code, fileName, startPosition } = diagnostic;
        const message = diagnosticMessage(diagnostic);
        const position = startPosition && fileName && path.normalize(fileName) === file
          ? lineStarts[startPosition.line] + startPosition.character
          : -1;
        const index = ranges.findLastIndex(range => range.start <= position);

        if (index < 0) {
          throw new Error(`Declaration TS${code} in ${fileName ?? 'compiler'}: ${message}`);
        }

        findings[offset + index].push({ code, message, offset: position - ranges[index].literalStart });
      }
    }

    return findings;
  };
}
