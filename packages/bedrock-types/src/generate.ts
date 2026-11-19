import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { exists, files, hash, safe } from './files.ts';
import { authoredDocuments, categoryKey, documentAliases, documents } from './layout.ts';
import { metadataSchemas, type MetadataSource } from './inputs/metadata.ts';
import { normalizeBehaviorEntities, normalizeEntities } from './fixes/entities.ts';
import { normalizeGeometry } from './fixes/geometry.ts';
import { normalizeBlockTextures, normalizeFlipbooks, normalizeTextureAtlases, normalizeTextureList, normalizeTextureSets } from './fixes/textures.ts';
import { normalizeBehaviorBiomes, normalizeClientBiomes } from './fixes/biomes.ts';
import { normalizeFeatureRules, normalizeScatterFeature } from './fixes/features.ts';
import { normalizeColorGrading } from './fixes/color-grading.ts';
import { normalizeSpawnRules } from './fixes/spawn-rules.ts';
import { emitFilterValues, normalizeEntityFilters } from './fixes/filters.ts';
import { normalizeLootTables } from './fixes/loot.ts';
import { normalizeFogs } from './fixes/fogs.ts';
import { normalizeLighting } from './fixes/lighting.ts';
import { prepareNativeSchemas } from './schema/native.ts';
import { normalizeMusicDefinitions, normalizeSoundDefinitions, normalizeSoundEvents } from './fixes/sounds.ts';
import { normalizeBlocks } from './fixes/blocks.ts';
import { compileCatalog } from './schema/compile.ts';
import { emitEntryPoints } from './emit.ts';
import { prepareDistribution } from './schema/distribution.ts';
import { componentDependencies, normalizeComponentRegistries } from './fixes/components.ts';

export interface GenerateOptions {
  root: string;
  schemaRoot: string;
  outputPath?: string;
  metadata?: MetadataSource;
  archiveFile?: string;
  categories?: readonly string[];
  log?: (message: string) => void;
}

export interface GenerateResult {
  changed: boolean;
  outputPath: string;
  categories: readonly string[];
}

async function pruneEmptyDirectories(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = path.join(directory, entry.name);

      await pruneEmptyDirectories(child);

      if (!(await readdir(child)).length) {
        await rmdir(child);
      }
    }
  }
}

/** Build the package's declaration distribution from immutable source inputs. */
export async function generateTypes(options: GenerateOptions): Promise<GenerateResult> {
  const root = path.resolve(options.root);
  const output = options.outputPath ?? path.join(root, 'dist');
  const cache = path.join(root, '.bedrock-core/cache/schema-types');
  const authored = path.join(root, 'types');
  const local = (await Promise.all(Object.entries(authoredDocuments).map(async ([key, definition]) =>
    await exists(path.join(authored, definition.file + '.d.ts')) ? { key, ...definition } : undefined,
  ))).filter(entry => entry !== undefined);
  const catalog = JSON.parse(await readFile(path.join(options.schemaRoot, 'catalog.json'), 'utf8')) as { schemas: { url: string }[] };
  const declared = catalog.schemas.map(entry => categoryKey(entry.url)).filter(key => Object.hasOwn(documents, key));
  const requested = (options.categories ?? [
    ...declared,
    ...local.map(entry => entry.key),
    ...(declared.includes('bp/blocks') ? ['assets/block-components'] : []),
    ...(declared.includes('rp/sounds') ? ['rp/sounds/events'] : []),
    ...(declared.includes('rp/textures/terrain_texture') ? ['rp/textures/texture_list'] : []),
    ...(options.metadata ? ['rp/biomes'] : []),
  ])
    .map(key => documentAliases[key] ?? key);
  const clients = requested.filter(key => key === 'rp/entity' || key === 'rp/attachables');
  const categories = [
    ...new Set([
      ...requested,
      ...componentDependencies(requested),
      ...(clients.length ? ['assets/client-resource'] : []),
      ...(requested.includes('bp/trading') ? ['bp/loot_tables'] : []),
    ]),
  ].sort();
  const log = options.log ?? (() => {});
  const blocks = categories.includes('bp/blocks') || categories.includes('assets/block-components');
  const biomes = categories.includes('bp/biomes');
  const native = blocks || biomes || categories.includes('rp/biomes');
  const metadata = native ? options.metadata : undefined;

  if (!categories.length || categories.some(key => !Object.hasOwn(documents, key))) {
    throw new Error('Requested schema categories must have public type names');
  }

  if (
    native
    && (!metadata
      || !/^[a-f0-9]{64}$/.test(metadata.sha256)
      || !metadata.url.startsWith('https://github.com/Mojang/bedrock-samples/releases/download/')
      || !/^\d+\.\d+\.\d+$/.test(metadata.componentVersion))
  ) {
    throw new Error('Native declarations require pinned Mojang metadata');
  }

  await safe(root, output);
  await safe(root, cache);
  const implementation = await files(fileURLToPath(new URL('./', import.meta.url)));
  const fingerprint = hash(
    JSON.stringify({
      schemas: await files(options.schemaRoot),
      metadata,
      categories,
      implementation: Object.fromEntries(Object.entries(implementation).filter(([name]) =>
        /^(fixes\/|schema\/|inputs\/metadata\.ts$|(emit|files|generate|layout)\.ts$)/.test(name))),
      authored: (await exists(authored)) ? await files(authored) : {},
    }),
  );
  const distribution = hash(path.relative(root, output)).slice(0, 16);
  const stateFile = path.join(cache, distribution + '.json');
  const lock = path.join(cache, distribution + '.lock');

  await safe(root, lock);
  await mkdir(cache, { recursive: true });
  const deadline = Date.now() + 120000;

  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) {
        throw error;
      }

      await setTimeout(50);
    }
  }

  let workspace: string | undefined;

  try {
    if (await exists(stateFile)) {
      const state = JSON.parse(await readFile(stateFile, 'utf8')) as { fingerprint: string; files: Record<string, string> };

      if (
        state.fingerprint === fingerprint
        && (await exists(output))
        && JSON.stringify(await files(output)) === JSON.stringify(state.files)
      ) {
        return { changed: false, outputPath: output, categories };
      }
    } else if ((await exists(output)) && Object.keys(await files(output)).length) {
      // Dist is the package-owned publication target; other paths are never replaced.
      log('Replacing the package declaration distribution');
    }

    log('Compiling ' + categories.length + ' schema categories');
    workspace = await mkdtemp(path.join(cache, 'compile-'));
    await safe(root, workspace);
    const source = path.join(workspace, 'source');
    const candidate = path.join(workspace, 'dist');

    await cp(options.schemaRoot, source, { recursive: true });
    await mkdir(candidate);
    const expression = path.join(source, 'schemas/common/expression.schema.json');

    if (!(await exists(expression))) {
      await mkdir(path.dirname(expression), { recursive: true });
      await writeFile(expression, JSON.stringify({ title: 'MolangExpression', type: ['string', 'number'] }));
    }

    await normalizeEntities(source, clients.map(key => key === 'rp/entity' ? 'entity' : 'attachables'));

    if (categories.includes('bp/entities')) {
      await normalizeBehaviorEntities(source);
    }

    if (categories.includes('rp/models')) {
      await normalizeGeometry(source);
    }

    if (categories.includes('rp/textures/texture_set')) {
      await normalizeTextureSets(source);
    }

    if (categories.includes('rp/textures/flipbook_textures')) {
      await normalizeFlipbooks(source);
    }

    await normalizeTextureAtlases(source, categories);

    if (categories.includes('rp/textures/texture_list')) {
      await normalizeTextureList(source);
    }

    if (categories.includes('rp/textures/blocks_resource')) {
      await normalizeBlockTextures(source);
    }

    if (categories.includes('rp/fogs')) {
      await normalizeFogs(source);
    }

    if (categories.includes('rp/deferred_rendering/lighting')) {
      await normalizeLighting(source);
    }

    if (categories.includes('rp/deferred_rendering/color_grading')) {
      await normalizeColorGrading(source);
    }

    if (categories.includes('rp/sounds')) {
      await normalizeSoundDefinitions(source);
    }

    if (categories.includes('rp/sounds/events')) {
      await normalizeSoundEvents(source);
    }

    if (categories.includes('rp/sounds/music_definitions')) {
      await normalizeMusicDefinitions(source);
    }

    if (categories.includes('bp/spawn_rules')) {
      await normalizeSpawnRules(source);
    }

    if (categories.includes('bp/features')) {
      await normalizeScatterFeature(source);
    }

    if (categories.includes('bp/feature_rules')) {
      await normalizeFeatureRules(source);
    }

    if (categories.includes('bp/loot_tables')) {
      await normalizeLootTables(source);
    }

    await normalizeComponentRegistries(source, categories);

    if (categories.includes('assets/entity-components')) {
      await normalizeEntityFilters(path.join(source, 'schemas/bp/entities'));
    }

    if (metadata) {
      const directory = path.join(workspace, 'metadata');
      const schemas = await metadataSchemas(metadata, cache, options.archiveFile);

      for (const [name, schema] of schemas) {
        const file = path.join(directory, name);

        await safe(root, file);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(schema));
      }

      await prepareNativeSchemas(source, directory);

      if (blocks) {
        log('Block components: ' + await normalizeBlocks(source, metadata.componentVersion));
      }

      if (biomes) {
        await normalizeBehaviorBiomes(source);
      }

      if (categories.includes('rp/biomes')) {
        await normalizeClientBiomes(source);
      }
    }

    const supplemental = local.filter(entry => categories.includes(entry.key));
    const generated = categories.filter(key => !supplemental.some(entry => entry.key === key));
    const compiled = [
      ...await compileCatalog({ source, output: candidate, categories: generated, log }),
      ...supplemental,
    ].sort((left, right) => left.file.localeCompare(right.file));

    await emitEntryPoints(candidate, compiled, authored);
    await emitFilterValues(source, candidate);
    await prepareDistribution(candidate, compiled);
    await cp(path.join(source, 'LICENSE'), path.join(candidate, 'attribution.txt'));
    const previous = (await exists(output)) ? await files(output) : {};
    const next = await files(candidate);

    for (const name of Object.keys(next)) {
      const target = path.join(output, name);
      const temporary = target + '.next';

      await safe(root, target);
      await mkdir(path.dirname(target), { recursive: true });

      try {
        await writeFile(temporary, await readFile(path.join(candidate, name)));
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }

    for (const name of Object.keys(previous)) {
      if (!Object.hasOwn(next, name)) {
        await rm(path.join(output, name), { force: true });
      }
    }

    await pruneEmptyDirectories(output);
    await writeFile(stateFile + '.next', JSON.stringify({ fingerprint, files: next }));
    await rename(stateFile + '.next', stateFile);

    return { changed: true, outputPath: output, categories };
  } finally {
    if (workspace) {
      await safe(root, workspace);
      await rm(workspace, { recursive: true, force: true });
    }

    await safe(root, lock);
    await rm(lock, { recursive: true, force: true });
  }
}
