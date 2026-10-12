import path from 'node:path';
import { compileI18n, type I18nSettings, type TranslationPack } from './index.ts';
import { cp, glob, mkdir, readFile, rm } from 'node:fs/promises';
import { generatedAliases, hasFiles, inspectPacks, resolveResourcePack, type BuildContext, type BuildDetection, type PackInfo } from '@bedrock-core/builder-plugin';
import { parseLang } from './lang.ts';
import { compileModule } from '@bedrock-core/builder-bundler/compile';

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function languageInputs(pack: PackInfo): Promise<boolean> {
  for await (const file of glob('texts/*.lang', { cwd: pack.path })) {
    if (Object.keys(parseLang(await readFile(path.join(pack.path, file), 'utf8'))).some(key => !['pack.name', 'pack.description'].includes(key))) {
      return true;
    }
  }

  return false;
}

/** Reserve pack-local locale directories before other producers discover templates. */
export function inputDirectories(context: BuildContext, settings: I18nSettings = {}): string[] {
  return Object.entries(context.packs).filter(([id]) => settings.owner === undefined || id === settings.owner).map(([id, root]) => {
    const directory = path.resolve(root, settings.sourceDir ?? 'i18n');

    if (!within(root, directory)) {
      throw new Error(`i18n sourceDir must be a directory inside owner pack ${id}`);
    }

    return directory;
  });
}

async function discover(context: BuildContext, settings: I18nSettings) {
  const graph = context.inspectPacks ? await context.inspectPacks() : await inspectPacks(context.allPacks ?? context.packs);
  const candidates = graph.filter(pack => Object.hasOwn(context.packs, pack.id) && pack.kind !== 'other' && (settings.owner === undefined || settings.owner === pack.id));

  if (settings.owner !== undefined && !candidates.length) {
    throw new Error(`i18n owner is not a selected behavior or resource pack: ${settings.owner}`);
  }

  const languages = new Map(await Promise.all(graph.map(async pack => [pack.id, await languageInputs(pack)] as const)));
  const sources = [];

  for (const owner of candidates) {
    const sourceDir = path.resolve(owner.path, settings.sourceDir ?? 'i18n');

    if (!within(owner.path, sourceDir)) {
      throw new Error(`i18n sourceDir must be a directory inside owner pack ${owner.id}`);
    }

    const modules = await hasFiles(sourceDir, '*.{ts,js,mts,mjs}', ['**/*.d.{ts,mts}']);
    const resources = (owner.dependencies ?? []).flatMap(dependency => dependency.kind === 'local' ? graph.filter(pack => pack.id === dependency.packId && pack.kind === 'resource' && (settings.resourcePack === undefined || settings.resourcePack === pack.id)) : []);
    const resourceOwnedByBehavior = owner.kind === 'resource' && candidates.some(pack => pack.kind === 'behavior' && pack.dependencies?.some(dependency => dependency.kind === 'local' && dependency.packId === owner.id));
    const needed = modules || (owner.kind === 'behavior' ? languages.get(owner.id) || resources.some(pack => languages.get(pack.id)) : !resourceOwnedByBehavior && languages.get(owner.id));

    sources.push({ owner, sourceDir, needed });
  }

  return { graph, sources };
}

/** Compile each selected pack's sources and register separate runtime bundles and resource contributions. */
export async function run(context: BuildContext, settings: I18nSettings): Promise<void> {
  const { graph, sources } = await discover(context, settings);
  const selected = sources.some(source => source.needed) ? sources.filter(source => source.needed) : sources.filter(source => settings.owner !== undefined || source.owner.kind === 'behavior' || sources.length === 1);
  const compiled = [];

  for (const { owner, sourceDir } of selected) {
    const resource = settings.client === false ? undefined : resolveResourcePack(graph, owner, settings.resourcePack);

    if (settings.client === false && settings.resourcePack !== undefined) {
      throw new Error('resourcePack cannot be selected when client output is disabled');
    }

    const routed = resource && resource.id !== owner.id ? [owner, resource] : [owner];
    const packs: TranslationPack[] = routed.map((pack) => {
      const header = pack.manifest?.header as { name?: string; description?: string } | undefined;

      return {
        path: pack.path, kind: pack.kind as 'behavior' | 'resource',
        aliases: pack.id === owner.id
          ? {
              ...(header?.name === 'pack.name' ? { name: 'pack.name' } : {}),
              ...(header?.description === 'pack.description' ? { description: 'pack.description' } : {}),
            }
          : {},
        ...(context.project ? { metadata: { name: context.project.name, description: context.project.description } } : {}),
      };
    });
    const declarationDir = path.join(context.projectRoot, '.bedrock-core/generated/i18n', owner.id);
    const result = await compileI18n({
      ...settings,
      root: context.stagedRoot,
      sourceDir,
      namespace: settings.namespace ?? context.namespace,
      packs,
      section: owner.id,
      moduleName: `@bedrock-core/generated/i18n/${owner.id}`,
      ...(context.project ? { metadata: { name: context.project.name, description: context.project.description, creator: context.project.authors.join(', ') } } : {}),
      dependencyRoot: context.projectRoot,
      aliases: generatedAliases(context, {}, owner.id),
      declarationRoot: context.projectRoot,
      declarationDir,
      outputDir: path.join(context.generatedDir, 'i18n', owner.id),
      typesDir: path.join(context.generatedDir, 'i18n-types', owner.id),
      cacheDir: path.join(context.projectRoot, '.bedrock-core/cache/i18n'),
      signal: context.signal,
      compile: options => compileModule(context, options),
      warn: message => context.logger.warn?.(`@bedrock-core/i18n:${owner.id}: ${message}`),
    });

    compiled.push({ owner, sourceDir, routed, declarationDir, result });
  }

  for (const { owner, sourceDir, routed, declarationDir, result } of compiled) {
    for (const input of result.inputs) {
      if (within(context.stagedRoot, input)) {
        context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, input)));
      } else if (!within(context.generatedDir, input)) {
        context.registerDependency(input);
      }
    }

    if (result.bundlePath) {
      await context.registerArtifact(`i18n:${owner.id}:bundle`, result.bundlePath, { importAs: '@bedrock-core/generated/i18n', pack: owner.id });
    }

    if (result.declarations.length) {
      await rm(declarationDir, { recursive: true, force: true });
      await mkdir(declarationDir, { recursive: true });

      for (const file of result.declarations) {
        await cp(file, path.join(declarationDir, path.basename(file)));
      }
    }

    context.excludeFromExport?.(sourceDir);

    for (const file of result.files) {
      const pack = routed.find(pack => within(pack.path, file));

      if (pack) {
        await context.registerArtifact(`i18n:${owner.id}:${pack.id}:${path.relative(pack.path, file).replaceAll('\\', '/')}`, file);
      }
    }
  }

  if (compiled.some(item => item.result.declarations.length)) {
    for (const file of ['i18n.generated.d.ts', 'vanilla.generated.d.ts']) {
      await rm(path.join(context.projectRoot, '.bedrock-core/generated/i18n', file), { force: true });
    }
  }
}

/** Detect only pack-owned locale modules and their associated native language inputs. */
export async function detect(context: BuildContext, settings: I18nSettings = {}): Promise<BuildDetection> {
  const { sources } = await discover(context, settings);
  const owners = sources.filter(source => source.needed).map(source => source.owner.id);

  return { needed: owners.length > 0, reason: owners.length ? `Found pack-owned translations: ${owners.join(', ')}` : 'No pack-owned translation inputs' };
}
