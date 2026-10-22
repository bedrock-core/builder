import { watch, type FSWatcher } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig, type ProjectConfig } from './config.ts';
import { resolveExportPaths } from './export.ts';
import { runBuild } from './run.ts';
import { inputLocations } from './file-cache.ts';
import { observeSourceWrites } from './source-writes.ts';
import type { BuildOptions, BuildResult } from './contract.d.ts';

/** Build options with required cancellation and optional result/error callbacks. */
export interface WatchOptions extends BuildOptions {
  /** Abort to stop watching and cancel the active build. */
  signal: AbortSignal;
  /** Called after a successful build; awaited before another build starts. */
  onBuild?: (result: BuildResult) => void | Promise<void>;
  /** Called for build errors while the watcher remains active. */
  onError?: (error: unknown) => void;
}

function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Build immediately, then coalesce filesystem changes into sequential rebuilds.
 * @param options Project inputs, settings and optional integrations for this operation.
 * @returns Resolves when watching stops; the signal cancels active work and closes watchers.
 * @remarks Rebuilds are sequential. Build failures are reported through onError and do not stop watching. Export paths and cache directories are excluded.
 */
export async function watchBuild(options: WatchOptions): Promise<void> {
  const { signal, logger = console, profile = 'default' } = options;

  if (signal.aborted) {
    return;
  }

  const configPath = await realpath(options.configPath ?? 'config.json');
  const project = path.dirname(configPath);
  const external = new Map<string, FSWatcher>();
  const recursiveExternal = new Map<string, boolean>();
  let externalTargets = new Map<string, Set<string>>();
  let outputRoots = new Set<string>();
  let extraPaths: string[] = [];
  let dependencies: string[] = [];
  let dependencyLocations: ReadonlySet<string> = new Set();
  let debounceMs = 100;
  let dirty = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let failure: unknown;
  const signatures = new Map<string, string>();
  const ownedWrites = new Set<string>();

  let removeAbortListener = () => {};

  function exportRoots(config: ProjectConfig): string[] {
    const selected = config.bedrockCore.profiles[profile];

    if (selected?.export) {
      resolveExportPaths(project, config.packs, selected.export);
    }

    return Object.values(config.bedrockCore.profiles).flatMap((settings) => {
      if (!settings.export) {
        return [];
      }

      try {
        return Object.values(resolveExportPaths(project, config.packs, settings.export));
      } catch {
        return [];
      }
    });
  }

  function ignored(file: string): boolean {
    const parts = path.relative(project, file).split(path.sep);

    if (parts.some(part => ['.git', 'node_modules', '.bedrock-core'].includes(part) || part.includes('.builder-data-'))) {
      return true;
    }

    for (const root of outputRoots) {
      const normalized = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;

      if (contains(root, file) || normalized(file).startsWith(`${normalized(root)}.builder-`)) {
        return true;
      }
    }

    return false;
  }

  function report(error: unknown): void {
    logger.error?.(`@bedrock-core/builder: ${error instanceof Error ? error.message : String(error)}`);
    options.onError?.(error);
  }

  function requestBuild(): void {
    if (stopped || signal.aborted) {
      return;
    }

    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!active) {
        active = rebuild().catch((error) => {
          failure = error;
          watcher.close();
        }).finally(() => {
          active = undefined;

          if (dirty && !stopped && !signal.aborted) {
            requestBuild();
          }
        });
      }
    }, debounceMs);
  }

  async function updateExternalWatchers(): Promise<void> {
    const targets = new Set([...extraPaths, ...dependencies].filter(file => !contains(project, file) || path.relative(project, file).split(path.sep).includes('node_modules')));
    const directories = new Map<string, Set<string>>();

    for (const target of targets) {
      let directory = dependencyLocations.has(target) ? path.dirname(target) : target;

      while (true) {
        try {
          if ((await stat(directory)).isDirectory()) {
            break;
          }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw error;
          }
        }

        directory = path.dirname(directory);
      }

      const group = directories.get(directory) ?? new Set<string>();

      group.add(target);
      directories.set(directory, group);
    }

    externalTargets = directories;

    for (const [directory, watcher] of external) {
      if (!externalTargets.has(directory)) {
        watcher.close();
        external.delete(directory);
        recursiveExternal.delete(directory);
      }
    }

    for (const directory of externalTargets.keys()) {
      const recursive = [...externalTargets.get(directory)!].some(target => target === directory && !dependencyLocations.has(target));

      if (external.has(directory) && recursiveExternal.get(directory) === recursive) {
        continue;
      }

      external.get(directory)?.close();
      const watcher = watch(directory, { recursive }, (_event, filename) => {
        const changed = filename ? path.resolve(directory, filename.toString()) : directory;
        const relevant = [...(externalTargets.get(directory) ?? [])].some(target => contains(target, changed) || contains(changed, target));

        if (relevant && ![...outputRoots].some(root => contains(root, changed))) {
          requestBuild();
        }
      });

      watcher.on('error', (error) => {
        watcher.close();
        external.delete(directory);
        recursiveExternal.delete(directory);
        report(error);
      });
      external.set(directory, watcher);
      recursiveExternal.set(directory, recursive);
    }
  }

  async function rebuild(): Promise<void> {
    while (dirty && !stopped && !signal.aborted) {
      dirty = false;

      try {
        const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
        const settings = config.bedrockCore.profiles[profile];

        if (!settings) {
          throw new Error(`Unknown profile: ${profile}`);
        }

        const roots = new Set(exportRoots(config));

        const generator = settings.stages?.generator;

        if (generator && typeof generator === 'object' && generator.types !== false && typeof generator.typesDir === 'string' && generator.typesDir) {
          roots.add(path.resolve(project, generator.typesDir));
        }

        // Retain former outputs as ignored paths after profile edits.
        outputRoots = new Set([...outputRoots, ...roots]);
        debounceMs = settings.watch?.debounceMs ?? 100;
        extraPaths = (settings.watch?.paths ?? []).map(file => path.resolve(project, file));
        await updateExternalWatchers();
        const result = await runBuild({ ...options, configPath });

        dependencies = result.dependencies;
        dependencyLocations = inputLocations(result);
        await updateExternalWatchers();
        logger.info?.(`@bedrock-core/builder: watching ${project}`);
        await options.onBuild?.(result);
      } catch (error) {
        if (!signal.aborted) {
          report(error);
        }
      }
    }
  }

  async function signature(file: string): Promise<string> {
    try {
      const info = await lstat(file, { bigint: true });

      if (info.isDirectory()) {
        const children = await readdir(file, { withFileTypes: true });
        const visible: string[] = [];

        for (const entry of children) {
          const child = path.join(file, entry.name);

          if (ignored(child)) {
            continue;
          }

          // Output-only parent folders do not add an observable project input.
          if (entry.isDirectory() && [...outputRoots].some(root => contains(child, root)) && await signature(child) === '') {
            continue;
          }

          visible.push(`${entry.name}:${entry.isDirectory() ? 'directory' : 'file'}`);
        }

        return visible.sort().join('|');
      }

      return `${info.mtimeNs}:${info.size}:${info.ino}`;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return 'missing';
      }

      throw error;
    }
  }

  async function snapshot(directory: string): Promise<void> {
    signatures.set(directory, await signature(directory));

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);

      if (ignored(file)) {
        continue;
      }

      if (entry.isDirectory()) {
        await snapshot(file);
      } else {
        signatures.set(file, await signature(file));
      }
    }
  }

  async function changed(file: string): Promise<void> {
    // Windows may emit unchanged directory events while recursive watches are attached.
    file = file.startsWith('\\\\?\\') ? file.slice(4) : file;

    if (ignored(file) || [...ownedWrites].some(root => contains(root, file))) {
      return;
    }

    const current = await signature(file);

    if ([...ownedWrites].some(root => contains(root, file))) {
      return;
    }

    const previous = signatures.get(file);

    // A new empty directory may contain only ignored output paths.
    if (current === '' && (previous === undefined || previous === 'missing')) {
      signatures.set(file, current);

      return;
    }

    if (previous !== current) {
      signatures.set(file, current);
      requestBuild();
    }
  }

  try {
    const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
    const settings = config.bedrockCore.profiles[profile];

    for (const directory of exportRoots(config)) {
      outputRoots.add(directory);
    }

    const generator = settings?.stages?.generator;

    if (generator && typeof generator === 'object' && generator.types !== false && typeof generator.typesDir === 'string' && generator.typesDir) {
      outputRoots.add(path.resolve(project, generator.typesDir));
    }
  } catch {
    // A malformed config stays observable so editing it can recover the build.
  }

  await snapshot(project);
  const watcher = watch(project, { recursive: true }, (_event, filename) => {
    const file = filename ? path.resolve(project, filename.toString()) : project;

    void changed(file).catch(report);
  });

  const stopObservingWrites = observeSourceWrites(project, (writes) => {
    const directories = writes.map(write => write.directory);

    for (const directory of directories) {
      ownedWrites.add(directory);
    }

    return async () => {
      try {
        for (const directory of directories) {
          for (const file of signatures.keys()) {
            if (contains(directory, file)) {
              signatures.set(file, await signature(file));
            }
          }

          await snapshot(directory);
          signatures.set(path.dirname(directory), await signature(path.dirname(directory)));
        }

        if ((await Promise.all(writes.map(write => write.matches()))).some(matches => !matches)) {
          requestBuild();
        }
      } catch (error) {
        report(error);
      } finally {
        for (const directory of directories) {
          ownedWrites.delete(directory);
        }
      }
    };
  });

  try {
    await new Promise<void>((resolve) => {
      const stop = () => {
        stopped = true;
        resolve();
      };

      signal.addEventListener('abort', stop, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', stop);
      watcher.once('error', (error) => {
        failure = error;
        stop();
      });
      watcher.once('close', stop);
      requestBuild();

      if (signal.aborted) {
        stop();
      }
    });
  } finally {
    stopped = true;
    stopObservingWrites();
    removeAbortListener();
    clearTimeout(timer);
    watcher.close();

    for (const watcher of external.values()) {
      watcher.close();
    }

    await active;
  }

  if (failure) {
    throw failure;
  }
}
