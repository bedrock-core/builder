import path from 'node:path';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isStringLiteral } from 'typescript-native/ast';
import { ModuleResolutionKind, type ModuleResolver } from 'typescript-native/sync';
import { findConfigFile, moduleResolutionOptions, trackedCompiler } from '@bedrock-core/builder-bundler/dependencies';
import type { ProjectConfig } from './config.ts';
import { planBuild } from './plan.ts';

const contains = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

/** Literal project paths omitted from staging and project watches. */
export function stagingExclusions(project: string, config: ProjectConfig, configPath = path.join(project, 'config.json')): string[] {
  const packs = Object.values(config.packs).map(directory => path.resolve(project, directory));
  const result = new Set<string>();

  for (const source of config.bedrockCore.staging?.exclude ?? []) {
    if (path.isAbsolute(source) || path.win32.isAbsolute(source) || /^[A-Za-z]:/.test(source) || /[*?\0]/.test(source)) {
      throw new Error('Staging exclusions must be literal project-relative paths: ' + source);
    }

    const file = path.resolve(project, source.replaceAll('\\', '/'));

    if (!contains(project, file) || path.relative(project, file) === '') {
      throw new Error('Staging exclusions must stay inside the project: ' + source);
    }

    if (contains(file, configPath) || packs.some(pack => contains(file, pack))) {
      throw new Error('Staging exclusions cannot omit the configuration or a pack source: ' + source);
    }

    result.add(file);
  }

  return [...result];
}

export const isStagingExcluded = (file: string, exclusions: readonly string[]): boolean => exclusions.some(directory => contains(directory, file));
/** A selected source or one of its ancestors needed to preserve project-relative paths. */
export const isStagingInput = (file: string, inputs: readonly string[]): boolean => inputs.some(input => contains(input, file) || contains(file, input));

/** Discover authored inputs without entering unrelated project directories or executing code. */
export async function stagingInputs(project: string, config: ProjectConfig, profile = 'default', configPath = path.join(project, 'config.json'), outputs: readonly string[] = [], signal?: AbortSignal): Promise<string[]> {
  const exclusions = stagingExclusions(project, config, configPath);
  const roots = new Set<string>();
  const pending: string[] = [];
  const visited = new Set<string>();
  let wholeProject = false;
  const normalized = (file: string): string => process.platform === 'win32' ? file.toLowerCase() : file;
  const ignored = (file: string): boolean => !contains(project, file)
    || path.relative(project, file).split(path.sep).some(part => ['.git', 'node_modules', '.bedrock-core'].includes(part) || part.includes('.builder-data-'))
    || isStagingExcluded(file, exclusions)
    || outputs.some(output => contains(output, file) || normalized(file).startsWith(`${normalized(output)}.builder-`));

  function add(file: string, module = false): void {
    file = path.resolve(project, file);

    if (ignored(file) || (file === project && !wholeProject)) {
      return;
    }

    if (module && file !== project && path.dirname(file) !== project) {
      file = path.dirname(file);
    }

    if (ignored(file)) {
      return;
    }

    if (!roots.has(file)) {
      roots.add(file);
      pending.push(file);
    }
  }

  add(configPath);
  add('package.json');

  for (const entry of await readdir(project, { withFileTypes: true })) {
    if (entry.isFile() && (/^tsconfig(?:\..+)?\.json$/i.test(entry.name) || /\.d\.[cm]?ts$/i.test(entry.name)
      || /^(?:licen[sc]e|copying)(?:\.(?:txt|md))?$/i.test(entry.name))) {
      add(entry.name);
    }
  }

  for (const source of config.bedrockCore.staging?.include ?? []) {
    if (path.isAbsolute(source) || path.win32.isAbsolute(source) || /^[A-Za-z]:/.test(source) || /[*?\0]/.test(source)
      || !contains(project, path.resolve(project, source.replaceAll('\\', '/')))) {
      throw new Error(`Staging inputs must be literal project-relative paths: ${source}`);
    }

    const input = path.resolve(project, source.replaceAll('\\', '/'));

    if (input === project) {
      wholeProject = true;
    }

    add(input);
  }

  for (const source of Object.values(config.packs)) {
    add(source);
  }

  for (const source of config.bedrockCore.profiles[profile]?.watch?.paths ?? []) {
    add(source);
  }

  const stages = config.bedrockCore.profiles[profile]?.stages;
  const generator = stages?.generator;
  const selectors = typeof generator === 'object' ? generator.include : undefined;

  for (const source of [selectors ?? []].flat()) {
    if (typeof source === 'string' && !/[*?[\]{}()]/.test(source)) {
      add(source);
    }
  }

  const ui = stages?.['ui-compiler'];
  const screens = typeof ui === 'object' && Array.isArray(ui.screens) ? ui.screens : [];
  const manifest = stages?.manifest;
  const manifestPaths = typeof manifest === 'object' ? manifest.manifestPath : undefined;

  for (const source of typeof manifestPaths === 'string' ? [manifestPaths] : Array.isArray(manifestPaths) ? manifestPaths : []) {
    if (typeof source === 'string') {
      add(source);
    }
  }

  for (const step of planBuild(config, profile)) {
    if (step.kind !== 'plugin') {
      continue;
    }

    if (step.module !== undefined) {
      if (step.module.startsWith('.') || path.isAbsolute(step.module)) {
        add(step.module, true);
      }
    } else {
      add(path.resolve(project, step.filterDir ?? '.', step.script), true);
      add(step.dataPath ?? 'data');
    }
  }

  try {
    const metadata = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')) as {
      exports?: unknown;
    };

    const visit = (entry: unknown): void => {
      if (typeof entry === 'string' && entry.startsWith('./')) {
        add(entry, true);
      } else if (entry && typeof entry === 'object') {
        Object.values(entry).forEach(visit);
      }
    };

    visit(metadata.exports);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const bundler = stages?.bundler;
  const explicitConfig = typeof bundler === 'object' && typeof bundler.tsconfig === 'string' ? path.resolve(project, bundler.tsconfig) : undefined;
  const resolvers = new Map<string | undefined, ModuleResolver>();
  const nearest = new Map<string, string | undefined>();
  const defaults = { moduleResolution: ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true };

  using api = trackedCompiler(add, (directory) => {
    if (!ignored(directory) && !existsSync(directory)) {
      add(directory);
    }
  });

  function resolverFor(directory: string): ModuleResolver {
    if (!explicitConfig && !nearest.has(directory)) {
      nearest.set(directory, findConfigFile(directory, add, 'tsconfig.json', project));
    }

    const configFile = explicitConfig ?? nearest.get(directory);
    const cached = resolvers.get(configFile);

    if (cached) {
      return cached;
    }

    const parsed = configFile ? api.parseConfigFile(configFile) : undefined;
    const resolver = api.createModuleResolver(parsed ? { ...defaults, ...moduleResolutionOptions(parsed.options) } : defaults);

    resolvers.set(configFile, resolver);

    if (configFile) {
      const raw = parsed?.raw as { files?: unknown; include?: unknown } | undefined;
      const directory = path.dirname(configFile);

      for (const source of Array.isArray(raw?.files) ? raw.files : []) {
        if (typeof source === 'string') {
          add(path.resolve(directory, source));
        }
      }

      for (const pattern of Array.isArray(raw?.include) ? raw.include : []) {
        if (typeof pattern === 'string') {
          const prefix = pattern.split(/[*?]/)[0];

          if (prefix && prefix !== './' && prefix !== '.') {
            add(path.resolve(directory, prefix));
          }
        }
      }
    }

    return resolver;
  }

  async function scan(file: string): Promise<void> {
    signal?.throwIfAborted();

    if (ignored(file) || visited.has(file)) {
      return;
    }

    visited.add(file);
    let info;

    try {
      info = await lstat(file);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return;
      }

      throw error;
    }

    if (info.isSymbolicLink() || path.relative(await realpath(file), file) !== '') {
      throw new Error(`Symlinks are unsupported in staged sources: ${file}`);
    }

    if (info.isDirectory()) {
      for (const entry of await readdir(file, { withFileTypes: true })) {
        await scan(path.join(file, entry.name));
      }
    } else if (/\.[cm]?[jt]sx?$/i.test(file)) {
      using parsed = api.createSourceFile(file, await readFile(file, 'utf8'));
      const source = parsed.sourceFile;

      for (const reference of source.referencedFiles) {
        add(path.resolve(path.dirname(file), reference.fileName));
      }

      for (const reference of source.typeReferenceDirectives) {
        if (reference.fileName.startsWith('.')) {
          add(path.resolve(path.dirname(file), reference.fileName));
        }
      }

      const directory = path.dirname(file);

      for (const imported of source.imports) {
        if (!isStringLiteral(imported)) {
          continue;
        }

        const resolution = resolverFor(directory).resolveModuleName(imported.text, directory).resolvedModule;

        if (resolution) {
          add(resolution.resolvedFileName);
        }
      }
    } else if (file.endsWith('.json')) {
      let document: {
        extends?: unknown;
      } | null;

      try {
        document = JSON.parse(await readFile(file, 'utf8')) as typeof document;
      } catch {
        // Stages own syntax diagnostics, including JSON templates awaiting expansion.
        return;
      }

      if (typeof document?.extends === 'string' && /^\.\.?[\\/]/.test(document.extends)) {
        add(path.resolve(path.dirname(file), document.extends));
      }
    }
  }

  resolverFor(project);

  for (const source of screens) {
    if (typeof source === 'string' && source.startsWith('.')) {
      add(source);
      const resolved = resolverFor(project).resolveModuleName(source, project).resolvedModule;

      if (resolved) {
        add(resolved.resolvedFileName);
      }
    }
  }

  for (let index = 0; index < pending.length; index++) {
    await scan(pending[index]!);
  }

  return [...roots].filter(file => ![...roots].some(other => other !== file && contains(other, file)));
}
