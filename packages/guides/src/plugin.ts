import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFiles, inspectPacks, resolveResourcePack, type BuildContext, type BuildDetection, type BuildStepResult } from '@bedrock-core/builder-plugin';
import type { GuidesSettings } from './index.ts';
import { compileProject, inside } from './project.ts';
export type { GuidesSettings } from './index.ts';

async function implementation(): Promise<string> {
  const directory = fileURLToPath(new URL('./', import.meta.url));
  const hash = createHash('sha256');

  for (const file of (await readdir(directory)).filter(file => /\.(?:ts|js)$/.test(file)).sort()) {
    hash.update(await readFile(path.join(directory, file)));
  }

  const packageFile = new URL('../package.json', import.meta.url);
  const metadata = await readFile(packageFile, 'utf8');
  const pkg = JSON.parse(metadata) as { dependencies: Record<string, string> };
  const require = createRequire(packageFile);
  const seen = new Set<string>();

  hash.update(metadata);

  async function dependency(name: string, resolver: NodeJS.Require): Promise<void> {
    // Declaration packages do not execute in the Markdown pipeline.
    if (name.startsWith('@types/')) {
      return;
    }

    const entry = resolver.resolve(name);

    if (seen.has(entry)) {
      return;
    }

    seen.add(entry);
    let directory = path.dirname(entry);

    hash.update(await readFile(entry));

    while (true) {
      try {
        const content = await readFile(path.join(directory, 'package.json'), 'utf8');

        const metadata = JSON.parse(content) as { name?: string; dependencies?: Record<string, string> };

        if (metadata.name === name) {
          hash.update(content);
          const nested = createRequire(path.join(directory, 'package.json'));

          for (const child of Object.keys(metadata.dependencies ?? {}).sort()) {
            await dependency(child, nested);
          }

          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      const parent = path.dirname(directory);

      if (parent === directory) {
        throw new Error(`Cannot identify the installed guide compiler dependency: ${name}`);
      }

      directory = parent;
    }
  }

  for (const name of Object.keys(pkg.dependencies).sort()) {
    await dependency(name, require);
  }

  return hash.digest('hex');
}

/**
 * Reserve pack-owned guide directories without evaluating content.
 * @param context Selected staged pack directories.
 * @param settings Optional owner restriction and sourceDir, resolved from each pack root.
 * @returns Absolute source directories reserved from template discovery.
 * @throws If a source directory leaves its owner pack or is the pack root.
 */
export function inputDirectories(context: BuildContext, settings: GuidesSettings = {}): string[] {
  return Object.entries(context.packs).filter(([id]) => settings.owner === undefined || id === settings.owner).map(([id, root]) => {
    const directory = path.resolve(root, settings.sourceDir ?? 'guides');

    if (!inside(root, directory)) {
      throw new Error(`guides sourceDir must be a directory inside owner pack ${id}`);
    }

    return directory;
  });
}

async function discover(context: BuildContext, settings: GuidesSettings) {
  const graph = context.inspectPacks ? await context.inspectPacks() : await inspectPacks(context.allPacks ?? context.packs);
  const candidates = graph.filter(pack => Object.hasOwn(context.packs, pack.id) && pack.kind !== 'other' && (settings.owner === undefined || settings.owner === pack.id));

  if (settings.owner !== undefined && !candidates.length) {
    throw new Error(`guides owner is not a selected behavior or resource pack: ${settings.owner}`);
  }

  const sources = [];

  for (const owner of candidates) {
    const sourceDir = path.resolve(owner.path, settings.sourceDir ?? 'guides');

    if (!inside(owner.path, sourceDir)) {
      throw new Error(`guides sourceDir must be a directory inside owner pack ${owner.id}`);
    }

    const locales = await readdir(sourceDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return [];
    });

    let needed = false;

    for (const locale of locales.filter(entry => entry.isDirectory())) {
      needed ||= await hasFiles(path.join(sourceDir, locale.name), settings.include ?? ['**/*.md', '**/*.mdx'], settings.exclude);
    }

    sources.push({ owner, sourceDir, needed });
  }

  return { graph, sources };
}

/**
 * Compile each selected pack's guides and route localized text to its local resource dependency.
 * @param context Staged packs, artifact registration, cache and export services.
 * @param settings Pack-relative paths, optional owner/resource IDs and compilation settings.
 * @returns Page compilation/reuse counts and whether every page was reused.
 * @throws On invalid ownership, missing or ambiguous resource dependencies, path violations or content conflicts.
 */
export async function run(context: BuildContext, settings: GuidesSettings): Promise<BuildStepResult> {
  const { graph, sources } = await discover(context, settings);
  const namespace = settings.namespace ?? context.namespace;
  const version = await implementation();
  const compiled = [];

  for (const { owner, sourceDir } of sources.filter(source => source.needed)) {
    if (settings.manifestPath && inside(sourceDir, path.resolve(owner.path, settings.manifestPath))) {
      throw new Error(`guides manifestPath must be outside the source directory in owner pack ${owner.id}`);
    }

    const screensDir = path.resolve(owner.path, settings.screensDir ?? 'scripts/guides');

    if (settings.compileScreens !== false && (screensDir === sourceDir || inside(sourceDir, screensDir) || inside(screensDir, sourceDir))) {
      throw new Error(`guides screensDir must be separate from the source directory in owner pack ${owner.id}`);
    }

    const resource = resolveResourcePack(graph, owner, settings.resourcePack);
    const routed = resource.id === owner.id ? [owner] : [owner, resource];
    const packs = routed.map(pack => ({ path: pack.path, kind: pack.kind as 'behavior' | 'resource' }));
    const declarationDir = path.join(context.projectRoot, '.bedrock-core/generated/guides', owner.id);
    const result = await compileProject({
      ...settings,
      root: owner.path,
      sourceDir,
      screensDir,
      namespace,
      packs,
      section: owner.id,
      moduleName: `@bedrock-core/generated/guides/${owner.id}`,
      outputDir: path.join(context.generatedDir, 'guides', owner.id),
      typesDir: path.join(context.generatedDir, 'guides-types', owner.id),
      signal: context.signal,
      warn: message => context.logger.warn?.(`@bedrock-core/builder: guides:${owner.id}: ${message}`),
    }, async (file, compile) => {
      const relative = path.relative(context.stagedRoot, file).replaceAll('\\', '/');
      const cached = await context.reuse(`page:${relative}`, {
        inputs: [file],
        key: {
          version,
          namespace,
          maxCodeLineBytes: settings.maxCodeLineBytes ?? 60,
          resources: packs
            .filter(pack => pack.kind === 'resource')
            .map(pack => path.relative(context.stagedRoot, pack.path)),
        },
        run: compile,
      });

      return { value: cached.value, inputs: cached.inputs, cached: cached.cached };
    });

    compiled.push({ owner, sourceDir, routed, declarationDir, result });
  }

  for (const { owner, sourceDir, routed, declarationDir, result } of compiled) {
    for (const file of result.inputs) {
      if (inside(context.stagedRoot, file)) {
        context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, file)));
      }
    }

    if (result.manifestPath) {
      await context.registerArtifact(`guides:${owner.id}:manifest`, result.manifestPath, { importAs: '@bedrock-core/generated/guides', pack: owner.id });
    }

    if (result.declarations.length) {
      await mkdir(declarationDir, { recursive: true });

      for (const file of result.declarations) {
        await cp(file, path.join(declarationDir, path.basename(file)));
      }
    }

    context.excludeFromExport?.(sourceDir);

    for (const file of result.files.filter(file => file.endsWith('.screen.tsx'))) {
      context.excludeFromExport?.(file);
    }

    for (const file of result.files.filter(file => file !== result.manifestPath)) {
      const pack = routed.find(pack => inside(pack.path, file));

      if (pack) {
        await context.registerArtifact(`guides:${owner.id}:${pack.id}:${path.relative(pack.path, file).replaceAll('\\', '/')}`, file);
      }
    }
  }

  if (compiled.some(item => item.result.declarations.length)) {
    await rm(path.join(context.projectRoot, '.bedrock-core/generated/guides/guides.generated.d.ts'), { force: true });
  }

  const pages = compiled.reduce((sum, item) => sum + item.result.pages, 0);
  const reused = compiled.reduce((sum, item) => sum + item.result.reused, 0);

  return { cached: pages === reused, reason: `${pages - reused} pages compiled, ${reused} reused` };
}

/**
 * Detect guide pages owned by the selected packs without loading MDX modules.
 * @param context Selected staged packs and their current manifests.
 * @param settings Optional owner and pack-relative source selection with per-locale include/exclude globs.
 * @returns Whether any selected owner has matching pages, with owner IDs in the reason.
 * @throws On invalid owner IDs, source paths or unreadable pack inputs.
 */
export async function detect(context: BuildContext, settings: GuidesSettings = {}): Promise<BuildDetection> {
  const { sources } = await discover(context, settings);
  const owners = sources.filter(source => source.needed).map(source => source.owner.id);

  return { needed: owners.length > 0, reason: owners.length ? `Found pack-owned guides: ${owners.join(', ')}` : 'No pack-owned guide pages' };
}
