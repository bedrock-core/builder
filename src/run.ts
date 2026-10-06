import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateConfig } from './config.ts';
import { planBuild } from './plan.ts';
import { inspectPack, type PackInfo } from './packs.ts';
import type { Artifact, BuildContext, BuildOptions, BuildResult } from './contract.d.ts';
export type {
  Artifact,
  BuildContext,
  BuildOptions,
  BuildResult,
  BuildStep,
  BuildPlugin,
} from './contract.d.ts';

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  return (
    relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
};

const check = (signal?: AbortSignal) => signal?.throwIfAborted();

/** Run trusted plugins against an isolated staged project and publish only successful packs. */
export async function runBuild({
  configPath = 'config.json',
  profile = 'default',
  stages = {},
  signal,
  logger = console,
  validateArtifacts,
}: BuildOptions): Promise<BuildResult> {
  const file = await realpath(configPath);
  const project = path.dirname(file);
  const config = validateConfig(JSON.parse(await readFile(file, 'utf8')));
  const plan = planBuild(config, profile);
  const implementations = { ...stages };

  if (
    plan.some(step => step.kind === 'stage' && step.stage === 'bundler')
    && !implementations.bundler
  ) {
    implementations.bundler = (await import('./stages/bundler.ts')).run;
  }

  const exportConfig = config.bedrockCore.profiles[profile]?.export;

  if (!exportConfig) {
    throw new Error('Profile needs export.path to execute a build');
  }

  const output = path.resolve(project, exportConfig.path);

  // Export is a dedicated project directory. Reject source roots and pack overlap.
  if (
    !inside(project, output)
    || ['.git', 'node_modules', '.bedrock-core'].includes(
      path.relative(project, output).split(path.sep)[0],
    )
  ) {
    throw new Error('Export must be a dedicated directory inside the project');
  }

  const packs = Object.fromEntries(
    Object.entries(config.packs).map(([id, relative]) => [id, path.resolve(project, relative!)]),
  );

  for (const source of Object.values(packs)) {
    if (
      !inside(project, source)
      || source === output
      || inside(source, output)
      || inside(output, source)
    ) {
      throw new Error('Pack and export paths must be separate project directories');
    }

    if (!(await stat(source)).isDirectory()) {
      throw new Error(`Pack is not a directory: ${source}`);
    }
  }

  for (const step of plan) {
    if (
      step.kind === 'stage'
      && !['prepare', 'validate', 'export'].includes(step.stage)
      && typeof implementations[step.stage] !== 'function'
    ) {
      throw new Error(`Stage implementation unavailable: ${step.stage}`);
    }
  }

  check(signal);
  // Loading is deferred until execution; resolving paths cannot execute module code.
  const require = createRequire(file);
  const modules = new Map<string, string>();

  for (const step of plan.filter(step => step.kind === 'plugin')) {
    const local = step.module.startsWith('.') || path.isAbsolute(step.module);
    const modulePath = local ? path.resolve(project, step.module) : require.resolve(step.module);

    if (local && !inside(project, await realpath(modulePath))) {
      throw new Error(`Plugin module must be inside the project: ${step.module}`);
    }

    modules.set(step.module, modulePath);
  }

  const ignored = new Set(['.git', 'node_modules', '.bedrock-core']);

  // Reject symlinks before copying or publishing, including export parent directories.
  async function inspect(directory: string, skipIgnored = true): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);

      if (skipIgnored && (source === output || ignored.has(entry.name))) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are unsupported in staged sources: ${source}`);
      }

      if (entry.isDirectory()) {
        await inspect(source, skipIgnored);
      }
    }
  }

  await inspect(project);
  await mkdir(path.dirname(output), { recursive: true });

  if (
    !inside(project, await realpath(path.dirname(output)))
    && (await realpath(path.dirname(output))) !== project
  ) {
    throw new Error('Export parent escapes the project');
  }

  if ((await exists(output)) && (await realpath(output)) !== output) {
    throw new Error('Export cannot be a symlink');
  }

  const lock = `${output}.builder-lock`;

  await mkdir(lock); // A second build for the same destination fails before staging.
  let workspace: string | undefined;
  let backup: string | undefined;
  let candidate: string | undefined;
  let published = false;
  const dependencies = new Set([file, ...modules.values()]);
  const artifacts = new Map<string, Artifact>();
  let publishedPacks: PackInfo[] = [];

  try {
    workspace = await mkdtemp(path.join(tmpdir(), 'bedrock-core-build-'));
    const staged = path.join(workspace, 'project');

    await cp(project, staged, {
      recursive: true,
      filter: source =>
        source !== output && source !== lock && !ignored.has(path.basename(source)),
    });
    const generated = path.join(workspace, 'generated');

    await mkdir(generated);
    const stagedPacks = Object.fromEntries(
      Object.entries(packs).map(([id, source]) => [
        id,
        path.join(staged, path.relative(project, source)),
      ]),
    );
    let owner = 'prepare';
    const context: BuildContext = Object.freeze({
      projectRoot: project,
      stagedRoot: staged,
      generatedDir: generated,
      packs: Object.freeze(stagedPacks),
      outputPath: output,
      profile,
      logger,
      signal,
      registerDependency(filePath: string) {
        dependencies.add(path.resolve(project, filePath));
      },
      async registerArtifact(id: string, filePath: string) {
        if (typeof id !== 'string' || !id.trim()) {
          throw new Error('Artifact ID must be nonempty');
        }

        const location = await realpath(path.resolve(staged, filePath));

        if (!inside(workspace!, location) || !(await stat(location)).isFile()) {
          throw new Error(`Artifact must be a staged file: ${id}`);
        }

        if (artifacts.has(id)) {
          throw new Error(`Artifact already registered: ${id}`);
        }

        artifacts.set(id, Object.freeze({ id, path: location, owner }));
      },
      artifact(id: string) {
        const artifact = artifacts.get(id);

        if (!artifact) {
          throw new Error(
            `Missing artifact: ${id}; select its producer or register an external input copied into staging`,
          );
        }

        return artifact;
      },
      async inspectPack(id: string) {
        const directory = stagedPacks[id];

        if (!directory) {
          throw new Error(`Pack is not configured: ${id}`);
        }

        return inspectPack(id, directory);
      },
    });

    for (const [index, step] of plan.entries()) {
      check(signal);
      owner = step.kind === 'plugin' ? `${step.plugin}:${index}` : step.stage;
      logger.info?.(`@bedrock-core/builder: ${owner}`);

      if (step.kind === 'plugin') {
        const url = pathToFileURL(modules.get(step.module)!);

        url.searchParams.set('build', path.basename(workspace));
        const plugin = await import(url.href);

        if (typeof plugin.run !== 'function') {
          throw new Error(`Plugin must export run(context, settings): ${step.plugin}`);
        }

        await plugin.run(context, step.settings);
      } else if (step.stage === 'validate') {
        for (const artifact of artifacts.values()) {
          const current = await realpath(artifact.path);

          if (!inside(workspace, current) || !(await stat(current)).isFile()) {
            throw new Error(`Invalid registered artifact: ${artifact.id}`);
          }
        }

        await validateArtifacts?.(context);
      } else if (step.stage === 'export') {
        publishedPacks = await Promise.all(Object.keys(stagedPacks).map(id => context.inspectPack(id)));
        await inspect(staged, false);
        candidate = `${output}.builder-${randomUUID()}`;
        await mkdir(candidate);

        for (const [id, source] of Object.entries(stagedPacks)) {
          await cp(source, path.join(candidate, id), { recursive: true });
        }

        await writeFile(
          path.join(candidate, 'build.json'),
          JSON.stringify({ profile, packs: publishedPacks.map(({ id, kind, moduleTypes, defaultDeploymentFolder }) => ({ id, kind, moduleTypes, defaultDeploymentFolder })) }, null, 2),
        );
        check(signal);

        if (await exists(output)) {
          backup = `${output}.builder-backup-${randomUUID()}`;
          await rename(output, backup);
        }

        try {
          await rename(candidate, output);
          candidate = undefined;
          published = true;
        } catch (error) {
          if (backup) {
            await rename(backup, output);
            backup = undefined;
          }

          throw error;
        }
      } else if (step.stage !== 'prepare') {
        await implementations[step.stage]!(context, step.settings ?? {});
      }
    }

    return Object.freeze({
      outputPath: output,
      profile,
      dependencies: [...dependencies],
      artifacts: [...artifacts.values()].map(({ id, owner }) => ({ id, owner })),
      packs: publishedPacks.map(pack => ({ ...pack, path: path.join(output, pack.id) })),
    });
  } finally {
    // All cleanup targets are owned mkdtemp/UUID paths or the lock acquired above.
    if (candidate) {
      await rm(candidate, { recursive: true, force: true });
    }

    // Retain the previous export if rollback itself failed.
    if (backup && published) {
      await rm(backup, { recursive: true, force: true });
    }

    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }

    await rm(lock, { recursive: true, force: true });
  }
}
