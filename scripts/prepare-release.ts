import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.bedrock-core/release/compiled');
const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const config = ts.parseJsonConfigFileContent({ ...configFile.config, include: ['src/**/*.ts', 'bin/**/*.ts', 'packages/**/*.ts'] }, ts.sys, root);
const program = ts.createProgram(config.fileNames, {
  ...config.options,
  target: ts.ScriptTarget.ES2023,
  noEmit: false,
  declaration: true,
  declarationMap: false,
  rewriteRelativeImportExtensions: true,
  rootDir: root,
  outDir: output,
});
const diagnostics = ts.getPreEmitDiagnostics(program);

if (diagnostics.length) {
  throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }));
}

await rm(output, { recursive: true, force: true });
const emitted = program.emit();

if (emitted.emitSkipped) {
  throw new Error('Release compilation did not emit package files');
}

const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { workspaces: string[] };

for (const workspace of ['.', ...metadata.workspaces]) {
  const directory = path.join(root, workspace);
  const dist = path.join(directory, 'dist');

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist);
  await cp(path.join(output, workspace, 'src'), path.join(dist, 'src'), { recursive: true });

  if (workspace === '.') {
    await cp(path.join(output, 'bin'), path.join(dist, 'bin'), { recursive: true });
    await cp(path.join(root, 'schemas'), path.join(dist, 'schemas'), { recursive: true });
    const contract = await readFile(path.join(root, 'src/contract.d.ts'), 'utf8');

    await writeFile(path.join(dist, 'src/contract.d.ts'), contract.replaceAll('.ts\'', '.js\''));
  } else if (workspace.endsWith('/validation')) {
    await cp(path.join(directory, 'schemas'), path.join(dist, 'schemas'), { recursive: true });
  }

  // Compiler fingerprints resolve metadata beside their release source directory.
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
    name: string; version: string; dependencies?: Record<string, string>;
  };
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).map(([name, version]) => [name, version.startsWith('workspace:') ? pkg.version : version]));

  await writeFile(path.join(dist, 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', dependencies }, null, 2)}\n`);

  if (workspace !== '.') {
    await cp(path.join(root, 'LICENSE'), path.join(directory, 'LICENSE'));
  }
}

console.log('@bedrock-core/builder: prepared JavaScript and declarations for all release packages');
