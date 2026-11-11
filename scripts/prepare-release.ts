import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScriptTarget } from 'typescript-native/ast';
import { API, formatDiagnosticsWithColorAndContext } from 'typescript-native/sync';
import { programDiagnostics } from '../packages/bundler/src/typescript.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.bedrock-core/release/compiled');
const configFileName = path.join(root, 'tsconfig.json');

using api = new API({ cwd: root });
const { config: authored, error } = api.readConfigFile(configFileName);

if (error) {
  throw new Error(formatDiagnosticsWithColorAndContext([error], api));
}

const config = api.parseJsonConfigFileContent({
  ...authored as object, include: ['src/**/*.ts', 'bin/**/*.ts', 'packages/**/*.ts'],
}, { configFileName });
const program = api.createProgram(config.fileNames, {
  ...config.options,
  target: ScriptTarget.ES2023,
  noEmit: false,
  declaration: true,
  declarationMap: false,
  rewriteRelativeImportExtensions: true,
  rootDir: root,
  outDir: output,
});
const diagnostics = [...config.errors, ...programDiagnostics(program)];

if (diagnostics.length) {
  throw new Error(formatDiagnosticsWithColorAndContext(diagnostics, api));
}

await rm(output, { recursive: true, force: true });
const emitted = program.emit();

if (emitted.diagnostics.length) {
  throw new Error(formatDiagnosticsWithColorAndContext(emitted.diagnostics, api));
}

if (emitted.emitSkipped) {
  throw new Error('Release compilation did not emit package files');
}

const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { workspaces: string[] };
const workspaces = await Promise.all([...new Set(['.', ...metadata.workspaces])].map(async (workspace) => {
  const directory = path.join(root, workspace);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
    name: string; version: string; dependencies?: Record<string, string>;
  };

  return { workspace, directory, pkg };
}));
const versions = new Map(workspaces.map(({ pkg }) => [pkg.name, pkg.version]));

for (const { workspace, directory, pkg } of workspaces) {
  const dist = path.join(directory, 'dist');

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist);
  await cp(path.join(output, workspace, 'src'), workspace === 'packages/cli' ? dist : path.join(dist, 'src'), { recursive: true });

  if (workspace === '.') {
    await cp(path.join(output, 'bin'), path.join(dist, 'bin'), { recursive: true });
    await cp(path.join(root, 'schemas'), path.join(dist, 'schemas'), { recursive: true });
    const contract = await readFile(path.join(root, 'src/contract.d.ts'), 'utf8');

    await writeFile(path.join(dist, 'src/contract.d.ts'), contract.replaceAll('.ts\'', '.js\''));
  } else if (workspace.endsWith('/validation')) {
    await cp(path.join(directory, 'schemas'), path.join(dist, 'schemas'), { recursive: true });
  }

  // Compiler fingerprints resolve metadata beside their release source directory.
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).map(([name, version]) => {
    if (!version.startsWith('workspace:')) {
      return [name, version];
    }

    const dependencyVersion = versions.get(name);

    if (!dependencyVersion) {
      throw new Error('Unknown workspace dependency: ' + name);
    }

    const range = version.slice('workspace:'.length);

    return [name, range === '*' ? dependencyVersion : range === '^' || range === '~' ? range + dependencyVersion : range];
  }));

  await writeFile(path.join(dist, 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', dependencies }, null, 2)}\n`);

  if (workspace !== '.') {
    await cp(path.join(root, 'LICENSE'), path.join(directory, 'LICENSE'));
  }
}

console.log('@bedrock-core/builder: prepared JavaScript and declarations for all release packages');
