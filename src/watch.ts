import { watch, type FSWatcher } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig, type ProjectConfig } from './config.ts';
import { resolveExportPaths } from './export.ts';
import { runBuild } from './run.ts';
import type { BuildOptions, BuildResult } from './contract.d.ts';

export interface WatchOptions extends BuildOptions {
  signal: AbortSignal;
  onBuild?: (result: BuildResult) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Rebuild serially, coalesce changes, and keep watching after build failures. */
export async function watchBuild(options: WatchOptions): Promise<void> {
  const { signal, logger = console, profile = 'default' } = options;

  if (signal.aborted) {
    return;
  }

  const configPath = await realpath(options.configPath ?? 'config.json');
  const project = path.dirname(configPath);
  const external = new Map<string, FSWatcher>();
  let outputRoots = new Set<string>();
  let extraPaths: string[] = [];
  let dependencies: string[] = [];
  let debounceMs = 100;
  let dirty = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let failure: unknown;
  const signatures = new Map<string, string>();

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

    if (parts.some(part => ['.git', 'node_modules', '.bedrock-core'].includes(part))) {
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

    for (const [target, watcher] of external) {
      if (!targets.has(target)) {
        watcher.close();
        external.delete(target);
      }
    }

    for (const target of targets) {
      if (external.has(target)) {
        continue;
      }

      let directory = target;

      while (true) {
        try {
          if ((await stat(directory)).isDirectory()) {
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }

        directory = path.dirname(directory);
      }

      const watcher = watch(directory, { recursive: true }, (_event, filename) => {
        const changed = filename ? path.resolve(directory, filename.toString()) : target;

        if ((contains(target, changed) || contains(changed, target)) && ![...outputRoots].some(root => contains(root, changed))) {
          requestBuild();
        }
      });

      watcher.on('error', (error) => {
        watcher.close();
        external.delete(target);
        report(error);
      });
      external.set(target, watcher);
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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

    if (ignored(file)) {
      return;
    }

    const current = await signature(file);
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
