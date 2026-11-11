import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript-native/ast';
import { formatDiagnostics, ModuleKind, ModuleResolutionKind, type RawCompilerOptions } from 'typescript-native/sync';
import { build } from 'esbuild';
import { resolveManifest, isManifestVersion, scriptOutputManifest, type JsonObject, type ApiPackageMetadata } from '@bedrock-core/builder-manifest';
import { inspectOwnApiModule, needsNativeAccess, type ApiShape } from './api.ts';
import { apiShapeSource } from './api-source.ts';
import { CompilationDependencies } from './dependencies.ts';
import { programDiagnostics, trackedCompiler } from './typescript.ts';

export interface ApiPackageOptions {
  /** Authored project containing package.json and explicit API exports. */
  root: string;
  /** Empty staged package directory. */
  output: string;
  /** Current manifests of participating script packs. */
  manifests: readonly JsonObject[];
  signal?: AbortSignal;
}

export interface EmittedApiPackage {
  name: string;
  version: string;
  files: string[];
  inputs: string[];
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const within = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const literalType = (value: unknown): string => Array.isArray(value)
  ? `readonly [${value.map(literalType).join(',')}]`
  : record(value)
    ? `{${Object.entries(value).map(([key, item]) => `readonly ${JSON.stringify(key)}: ${literalType(item)};`).join('')}}`
    : JSON.stringify(value) ?? 'undefined';
const needsTransport = (shape: ApiShape): boolean => shape.kind === 'object'
  ? Object.values(shape.members).some(needsTransport)
  : ['function', 'state', 'event'].includes(shape.kind);
const declarationPath = (file: string): string => /\.d\.[cm]?ts$/.test(file) ? file : file.replace(/\.[cm]?[jt]sx?$/, extension => extension.startsWith('.m') ? '.d.mts' : extension.startsWith('.c') ? '.d.cts' : '.d.ts');

const relativeImport = (from: string, to: string): string => {
  const relative = path.relative(path.dirname(from), to).replaceAll('\\', '/');

  return relative.startsWith('.') ? relative : `./${relative}`;
};

/** Publishable clients and declarations are derived once from the provider's checked exports. */
export async function emitApiPackage({ root, output, manifests, signal }: ApiPackageOptions): Promise<EmittedApiPackage | undefined> {
  const packageFile = path.join(root, 'package.json');
  const metadata: unknown = JSON.parse(await readFile(packageFile, 'utf8'));

  if (!record(metadata) || typeof metadata.name !== 'string' || !record(metadata.exports)) {
    throw new Error('API package emission requires a package name and explicit exports');
  }

  const name = metadata.name;
  const entries = Object.keys(metadata.exports);
  const modules = await Promise.all(entries.map(subpath => inspectOwnApiModule(root, subpath)));

  if (modules.some(module => !manifests.some(manifest => record(manifest.header) && manifest.header.uuid === module.uuid && manifest.namespace === module.namespace))) {
    return;
  }

  const primary = modules.find(module => module.moduleName === name) ?? modules[0];
  const primaryOwner = manifests.find(manifest => record(manifest.header) && manifest.header.uuid === primary.uuid);
  const version = typeof metadata.version === 'string' ? metadata.version : record(primaryOwner?.header) ? primaryOwner.header.version : undefined;

  if (typeof version !== 'string' || !isManifestVersion(version)) {
    throw new Error('API package needs a package version or primary manifest header.version');
  }

  const inputs = new Set([packageFile, ...modules.flatMap(module => module.inputs)]);
  const files = new Set<string>();
  const shared = new Map<string, string>();
  const exports: Record<string, Record<string, string>> = {};
  const owners: ApiPackageMetadata = { formatVersion: '1.0.0', manifests: {} };

  if (modules.some(module => needsNativeAccess(module.shape))) {
    owners.nativeAccess = true;
  }

  const dependencies = new Set(['@bedrock-core/server-runtime']);
  const declarations = new Map<string, string>();
  const origins = new Map<string, ts.SourceFile>();
  const sources: string[] = [];

  const put = async (file: string, text: string): Promise<void> => {
    signal?.throwIfAborted();
    assert.ok(within(output, file), 'API outputs must stay inside their staged package');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    files.add(file);
  };

  for (const [index, module] of modules.entries()) {
    const subpath = entries[index];

    assert.ok(subpath === '.' || (subpath.startsWith('./') && !subpath.includes('*') && !subpath.split('/').includes('..')), 'API packages require explicit, relative export subpaths');
    const stem = subpath === '.' ? 'index' : subpath.slice(2);
    const entry = path.join(output, 'entries', `${stem}.js`);
    const owner = manifests.find(manifest => record(manifest.header) && manifest.header.uuid === module.uuid)!;
    const identity = path.join(output, 'identity', `${module.namespace}.json`);

    owners.manifests[subpath] = relativeImport(path.join(output, 'package.json'), identity);

    if (!files.has(identity)) {
      await put(identity, JSON.stringify(owner));
    }

    if (!Object.keys(module.shape.members).length) {
      const declaration = module.declaration ?? module.source;

      sources.push(declaration);
      exports[subpath] = { types: relativeImport(path.join(output, 'package.json'), path.join(output, 'types', declarationPath(path.relative(root, declaration)))) };
      continue;
    }

    const shape = apiShapeSource(module.shape, (file) => {
      if (!shared.has(file)) {
        shared.set(file, path.join(output, 'shared', `value${shared.size}.js`));
      }

      return relativeImport(entry, shared.get(file)!);
    });
    const body = [
      ...shape.imports,
      `const api = createApiModule(${JSON.stringify(module.namespace)}, ${JSON.stringify(module.moduleName)}, ${shape.shape});`,
      ...Object.keys(module.shape.members).map((key, index) => `const member${index} = api[${JSON.stringify(key)}]; export { member${index} as ${JSON.stringify(key)} };`),
    ];

    await put(entry, [needsTransport(module.shape)
      ? 'import { createClientApiModule as createApiModule } from "@bedrock-core/server-runtime/api/client";'
      : 'import { createApiModule } from "@bedrock-core/server-runtime/api";', ...body].join('\n'));
    exports[subpath] = { types: '', import: relativeImport(path.join(output, 'package.json'), entry) };

    if (needsTransport(module.shape)) {
      const evaluator = path.join(output, 'entries', `${stem}.build.js`);

      await put(evaluator, ['import { createApiModule } from "@bedrock-core/server-runtime/api";', ...body].join('\n'));
      exports[subpath]['bedrock-core-build'] = relativeImport(path.join(output, 'package.json'), evaluator);
    }

    if (module.source.endsWith('.json')) {
      const resolved = await resolveManifest(module.source, { root, validate: false });
      const manifest = scriptOutputManifest(resolved.manifest);

      resolved.inputs.forEach(file => inputs.add(file));
      const declaration = [
        `declare const manifest: ${literalType(manifest)};`,
        'export default manifest;',
        ...Object.entries(manifest).filter(([key]) => key !== 'default').map(([key, value], index) => `declare const field${index}: ${literalType(value)}; export { field${index} as ${JSON.stringify(key)} };`),
      ].join('\n');
      const file = path.join(output, 'types', `${stem}.d.ts`);

      await put(file, declaration);
      exports[subpath].types = relativeImport(path.join(output, 'package.json'), file);
    } else {
      const declaration = module.declaration ?? module.source;

      sources.push(declaration);
      exports[subpath].types = relativeImport(path.join(output, 'package.json'), path.join(output, 'types', declarationPath(path.relative(root, declaration))));
    }
  }

  const tracking = new CompilationDependencies(root);
  const { jsx, jsxImportSource, preserveSymlinks } = tracking.config(root);
  const options: RawCompilerOptions = {
    target: ts.ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: true, allowJs: true, declaration: true, emitDeclarationOnly: true,
    resolveJsonModule: true, allowImportingTsExtensions: true, types: [], rootDir: root, outDir: path.join(output, 'types'),
    jsx, jsxImportSource, preserveSymlinks,
  };

  using api = trackedCompiler(file => inputs.add(file));
  const program = api.createProgram(sources, options);
  const emitted = program.emitToString();
  const diagnostics = [...programDiagnostics(program), ...emitted.diagnostics];

  if (diagnostics.length) {
    throw new Error(formatDiagnostics(diagnostics, api));
  }

  for (const [file, emittedFile] of emitted.outputFiles) {
    const destination = path.resolve(file);
    const origin = emittedFile.sourceFileName && program.getSourceFile(emittedFile.sourceFileName);

    declarations.set(destination, emittedFile.text);

    if (origin) {
      origins.set(destination, origin);
    }
  }

  for (const name of program.getSourceFileNames()) {
    if (!/\.d\.[cm]?ts$/.test(name) || !within(root, name) || path.normalize(name).split(path.sep).includes('node_modules')) {
      continue;
    }

    const source = program.getSourceFile(name);

    if (source?.isDeclarationFile) {
      const destination = path.join(output, 'types', path.relative(root, source.fileName));

      declarations.set(destination, source.text);
      origins.set(destination, source);
    }
  }

  const copied = new Set<string>();

  using resolver = api.createModuleResolver(options);

  const ambient = (file: ts.SourceFile, seen = new Set<string>()): boolean => {
    if (seen.has(file.fileName)) {
      return false;
    }

    seen.add(file.fileName);

    return file.statements.some(node => ts.isModuleDeclaration(node)
      || (ts.isImportDeclaration(node) && !node.importClause && ts.isStringLiteral(node.moduleSpecifier)
        && (() => {
          const target = resolver.resolveModuleName(node.moduleSpecifier.text, path.dirname(file.fileName)).resolvedModule;
          const source = target && program.getSourceFile(target.resolvedFileName);

          return source ? ambient(source, seen) : false;
        })()));
  };

  const copyDeclaration = async (file: string): Promise<void> => {
    file = path.resolve(file);

    if (copied.has(file)) {
      return;
    }

    copied.add(file);
    const original = declarations.get(file);

    if (original === undefined) {
      throw new Error(`Missing public declaration dependency: ${file}`);
    }

    const parsed = api.createSourceFile(file, original);
    const origin = origins.get(file);
    const specifiers = new Set<string>();
    const edits: { start: number; end: number; text: string }[] = [];

    const addSpecifier = (specifier: ts.StringLiteral): void => {
      specifiers.add(specifier.text);

      if (specifier.text.startsWith('.') && /\.(tsx?|mts|cts)$/.test(specifier.text) && !/\.d\.[cm]?ts$/.test(specifier.text)) {
        const rewritten = specifier.text.replace(/\.(tsx?|mts|cts)$/, extension => extension === '.mts' ? '.mjs' : extension === '.cts' ? '.cjs' : '.js');

        edits.push({ start: specifier.getStart(), end: specifier.end, text: JSON.stringify(rewritten) });
      }
    };

    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (ts.isImportDeclaration(node) && !node.importClause && origin) {
          const resolved = resolver.resolveModuleName(node.moduleSpecifier.text, path.dirname(origin.fileName)).resolvedModule;
          const target = resolved && program.getSourceFile(resolved.resolvedFileName);

          if (!target || !ambient(target)) {
            edits.push({ start: node.getStart(), end: node.end, text: '' });

            return;
          }
        }

        addSpecifier(node.moduleSpecifier);
      }

      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        addSpecifier(node.argument.literal);
      }

      node.forEachChild(visit);
    };

    try {
      visit(parsed.sourceFile);

      for (const ref of parsed.sourceFile.referencedFiles) {
        specifiers.add(`./${ref.fileName}`);
      }
    } finally {
      parsed.dispose();
    }

    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        const candidates = [target, declarationPath(target), `${target}.d.ts`, path.join(target, 'index.d.ts')];
        let found = candidates.find(candidate => declarations.has(candidate));

        if (!found) {
          const authored = path.join(root, path.relative(path.join(output, 'types'), target));
          const existing = program.getSourceFile(authored);

          if (existing?.isDeclarationFile && within(root, authored)) {
            declarations.set(target, existing.text);
            origins.set(target, existing);
            found = target;
          }
        }

        if (!found) {
          throw new Error(`Cannot resolve public declaration ${specifier} from ${file}`);
        }

        await copyDeclaration(found);
      } else {
        const parts = specifier.split('/');

        dependencies.add(parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));
      }
    }

    let rewritten = original;

    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
    }

    await put(file, rewritten);
  };

  for (const entry of Object.values(exports)) {
    const file = path.resolve(output, entry.types);

    if (declarations.has(file)) {
      await copyDeclaration(file);
    }
  }

  for (const [index, module] of modules.entries()) {
    if (!module.consumerView) {
      continue;
    }

    const entry = exports[entries[index]];
    const authored = path.resolve(output, entry.types);
    const wrapper = path.join(output, 'types', 'clients', `${index}.d.ts`);
    const source = relativeImport(wrapper, authored).replace(/\.d\.([cm]?)ts$/, '.$1js');
    const lines = [
      `import type { ApiModule } from '@bedrock-core/server-runtime/api';`,
      `import type * as Authored from ${JSON.stringify(source)};`,
      `export type * from ${JSON.stringify(source)};`,
      ...Object.entries(module.shape.members).map(([name, shape], member) => shape.kind === 'local'
        ? `export { ${JSON.stringify(name)} } from ${JSON.stringify(source)};`
        : `declare const member${member}: ApiModule<typeof Authored[${JSON.stringify(name)}]>; export { member${member} as ${JSON.stringify(name)} };`),
    ];

    await put(wrapper, lines.join('\n'));
    entry.types = relativeImport(path.join(output, 'package.json'), wrapper);
  }

  if (shared.size) {
    const built = await build({
      absWorkingDir: root,
      entryPoints: [...shared].map(([input, target]) => ({ in: input, out: path.basename(target, '.js') })),
      outdir: path.join(output, 'shared'), bundle: true, splitting: true, format: 'esm', platform: 'neutral',
      external: ['@bedrock-core/*', '@minecraft/*'], metafile: true, sourcemap: false,
      plugins: [{ name: 'api-package-inputs', setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          tracking.imports(args.path, args.resolveDir || root);

          return undefined;
        });
      } }],
    });

    for (const [file, info] of Object.entries(built.metafile.outputs)) {
      if (info.imports.some(item => item.external)) {
        throw new Error('Shared API values must be engine-free and self-contained');
      }

      files.add(path.resolve(root, file));
    }

    Object.keys(built.metafile.inputs).forEach(file => inputs.add(path.resolve(root, file)));
  }

  tracking.files.forEach(file => inputs.add(file));

  const require = createRequire(packageFile);
  const packageDependencies: Record<string, string> = {};
  const peers: Record<string, string> = {};

  for (const dependency of [...dependencies].sort()) {
    let installed: Record<string, unknown> | undefined;

    for (const directory of require.resolve.paths(dependency) ?? []) {
      const file = path.join(directory, dependency, 'package.json');

      inputs.add(file);

      try {
        const candidate: unknown = JSON.parse(await readFile(file, 'utf8'));

        if (record(candidate) && candidate.name === dependency) {
          installed = candidate;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    if (!installed || typeof installed.version !== 'string') {
      throw new Error(`Cannot locate API dependency metadata for ${dependency}`);
    }

    if (dependency.startsWith('@minecraft/')) {
      peers[dependency] = installed.version;
    } else {
      packageDependencies[dependency] = `^${installed.version}`;
    }
  }

  await put(path.join(output, 'package.json'), `${JSON.stringify({
    name, version, type: 'module', exports,
    ...Object.fromEntries(['description', 'license', 'repository', 'homepage'].filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]])),
    bedrockCore: { api: owners }, dependencies: packageDependencies, peerDependencies: peers,
    files: ['entries', 'shared', 'types', 'identity'],
  }, null, 2)}\n`);

  return { name, version, files: [...files], inputs: [...inputs] };
}
