import type { CompileInput } from './compiler/compiler.ts';
import type { CheckedStates, GeyserMapping } from './compiler/types.ts';
import type { Bindings, Coverage, GenerationSummary, Resources } from './bedrock/types.ts';
import type { RendererProfile, SourceLock, Sources } from './sources/types.ts';
import type { CanonicalInverse } from './compiler/inverse.ts';
import type { TextureBindings } from './compiler/textures.ts';
import type { AuditReport } from './audit.ts';
import { asError, isRecord } from './json.ts';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bedrockResources } from './sources/pack.ts';
import { nativeAssets } from './bedrock/native.ts';
import { javaResources, javaAtlas, javaRuntime, jsonBytes, validateJavaManifest } from './sources/java.ts';
import { buildTextureNames } from './sources/texture-names.ts';
import { buildRendererInputs } from './sources/renderer-input.ts';
import { authoredDefinitions, writeDocuments, supplementDocuments } from './bedrock/documents.ts';
import { auditDocuments } from './audit.ts';
import { lockedInput } from './sources/download.ts';
import { compileModels } from './compiler/compiler.ts';
import { buildInverse } from './compiler/inverse.ts';
import { alphaMethod, pngAlpha, zipFiles } from './sources/formats.ts';
import { buildTextureBindings, nativeTextureImages, textureCandidates } from './compiler/textures.ts';
import { cache, data as directory, distribution, reports } from './paths.ts';
import { readAssetInput, readAssetRelease, releaseOutput, type AssetInputFiles } from './releases.ts';

export interface RefreshOptions {
  version?: string; offline?: boolean; forceJava?: boolean; statesFile?: string; definitionsDirectory?: string;
  check?: boolean; output?: string; pretty?: boolean;
}

type PreparationOptions = RefreshOptions & { sourceOverride?: Sources; inputDirectory?: string; fallbackDirectory?: string };

export interface RefreshStatistics {
  minecraft: string; java: string; mappings: string; sourceRevision: string;
  nativeDocuments: number; javaBlocks: number; javaModels: number; rendererModels: number; sprites: number; textureNames: number;
  textureFaces: TextureBindings['statistics']; documents: number; coveredStates: number; auditErrors: number; auditGaps: number;
}

export interface RefreshReport extends RefreshStatistics, GenerationSummary { version: string; outputPath: string }

export interface PreparedRefresh {
  sourceLock: SourceLock; licenses: Record<string, Buffer>; inputs: AssetInputFiles;
  states: CheckedStates; bindings: Bindings; originalBindings: Bindings; inverse: CanonicalInverse; resources: Resources;
  previous?: Coverage; coverage: Coverage; audit: AuditReport; documents: Resources; report: RefreshStatistics;
}

const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + '\n');

export function validateSources(source: Sources): Sources {
  const target = source.bedrock?.minecraft;

  if (source.schemaVersion !== 1 || !/^\d+\.\d+\.\d+\.\d+$/.test(target) || !['stable', 'preview'].includes(source.bedrock.channel)
    || source.bedrock.repository !== 'https://github.com/Mojang/bedrock-samples' || source.bedrock.tag !== 'v' + target + (source.bedrock.channel === 'preview' ? '-preview' : '')
    || !source.bedrock.archive?.url?.startsWith(`https://github.com/Mojang/bedrock-samples/releases/download/${source.bedrock.tag}/`)
    || !source.java?.manifest?.url?.startsWith('https://piston-meta.mojang.com/') || !source.java.client?.url?.startsWith('https://piston-data.mojang.com/')
    || !Array.isArray(source.java.libraries) || source.java.libraries.some(library => !library.url.startsWith('https://libraries.minecraft.net/'))
    || source.mappings?.java !== source.java.version || source.mappings.bedrock !== target.split('.').slice(0, 3).join('.')
    || !source.mappings.archive?.url?.startsWith(`https://github.com/GeyserMC/mappings-generator/releases/download/${source.mappings.version}/`)) { throw new Error('Asset source families or their Java/Bedrock version pair do not match'); }

  const inputs = [source.bedrock.archive, source.bedrock.license, source.java.manifest, source.java.client, ...source.java.libraries, source.mappings.archive];

  if (inputs.some(input => !/^[a-f0-9]{64}$/.test(input?.sha256) || !input?.url?.startsWith('https://'))) {
    throw new Error('Every upstream input requires an immutable SHA-256 pin');
  }

  return source;
}

const failures = (coverage: Coverage): Map<string, number> => {
  const result = new Map<string, number>();

  for (const value of [...coverage.gaps, ...coverage.issues]) {
    const key = value.kind + '/' + value.id;

    result.set(key, (result.get(key) ?? 0) + (value.affectedStates ?? value.missingStates ?? 1));
  }

  return result;
};

/** Reject loss of existing coverage before publishing native supplements. */
export function assertCoverageParity(before: Coverage, after: Coverage): void {
  if (before.minecraft !== after.minecraft) {
    return;
  }

  const baseline = failures(before), regressions = [...failures(after)].filter(([id, count]) => count > (baseline.get(id) ?? 0));

  if (after.generatedBlockStates < before.generatedBlockStates || regressions.length) {
    throw new Error('Asset refresh regresses native coverage: ' + JSON.stringify(regressions.slice(0, 20)));
  }
}

export async function prepareAssetRefresh({
  version, offline = false, forceJava = false, statesFile, sourceOverride, inputDirectory, fallbackDirectory,
  output = version ? releaseOutput(version) : distribution,
  definitionsDirectory = fileURLToPath(new URL('../definitions/', import.meta.url)),
}: PreparationOptions = {}): Promise<PreparedRefresh> {
  const release = inputDirectory ? undefined : await readAssetRelease(version);
  const inputsDirectory = inputDirectory ?? release!.directory;
  const sourceBytes = sourceOverride
    ? Buffer.from(JSON.stringify(sourceOverride, null, 2) + '\n')
    : release?.sourceBytes ?? await readAssetInput(inputsDirectory, 'sources.json', fallbackDirectory);
  const source = validateSources(JSON.parse(sourceBytes.toString('utf8')));
  const [stateBytes, bindingBytes, profileBytes, ruleBytes] = await Promise.all([
    statesFile ? readFile(resolve(statesFile)) : readAssetInput(inputsDirectory, 'native-states.json', fallbackDirectory),
    readAssetInput(inputsDirectory, 'native-bindings.json', fallbackDirectory),
    readAssetInput(inputsDirectory, 'renderer-profiles.json', fallbackDirectory),
    readAssetInput(inputsDirectory, 'texture-rules.json', fallbackDirectory),
  ]);
  const states: CheckedStates = JSON.parse(stateBytes.toString('utf8'));
  const originalBindings: Bindings = JSON.parse(bindingBytes.toString('utf8'));
  const profile: RendererProfile = JSON.parse(profileBytes.toString('utf8'));
  const rules: { aliases: Record<string, string> } = JSON.parse(ruleBytes.toString('utf8'));
  const bindings = statesFile ? { ...originalBindings, minecraft: states.version } : originalBindings;

  if (states.version !== source.bedrock.minecraft || bindings.minecraft !== source.bedrock.minecraft) {
    throw new Error('Matching native state inventory and relationship bindings are required for the pinned Bedrock release');
  }

  const [bedrock, client, mappingArchive, manifestBytes, license, runtime] = await Promise.all([
    lockedInput(source.bedrock.archive, cache, { offline, extension: '.zip', maxBytes: 256 * 1024 * 1024 }),
    lockedInput(source.java.client, cache, { offline, extension: '.jar', maxBytes: 128 * 1024 * 1024 }),
    lockedInput(source.mappings.archive, cache, { offline, extension: '.zip' }),
    lockedInput(source.java.manifest, cache, { offline }), lockedInput({ url: source.bedrock.license.url, sha256: source.bedrock.license.sha256 }, cache, { offline }),
    javaRuntime(source.java, cache, { offline, force: forceJava }),
  ]);

  validateJavaManifest(source.java, manifestBytes);
  const resources = bedrockResources(bedrock), native = nativeAssets(resources, { target: states.version, bindings: { blocks: bindings.blocks } });
  const java = javaResources(client), atlas = javaAtlas(java.sprites), archive = zipFiles(mappingArchive);
  const mappings: Record<string, GeyserMapping> | null = JSON.parse(archive.get('data/blocks_debug.json')?.().toString('utf8') ?? 'null');

  if (!mappings || !archive.has('LICENSE')) {
    throw new Error('The Geyser source lacks its forward mapping or license');
  }

  const flipbooks = resources.get('textures/flipbook_textures.json');
  const images = nativeTextureImages(bedrock, Array.isArray(flipbooks) ? flipbooks.filter(isRecord) : []);
  const defaults = { javaVersion: source.java.version, blocks: runtime.blocks };
  const names = buildTextureNames({ resources: java, defaults, mappings, native, images, rules });
  const inverseSources = { schemaVersion: 1 as const, java: source.java.version, defaults: { sha256: hash(bytes(defaults)) }, policy: source.policy };
  const textureSources = { schemaVersion: 1 as const, minecraft: states.version, archive: source.bedrock.archive };
  const revision = hash(jsonBytes({ sources: source, nativeRevision: states.revision, javaExtraction: runtime.extractionRevision, profile, rules }));
  const png = pngAlpha(atlas.png), textureCache = new Map<string, ReturnType<CompileInput['texture']>>();

  const texture: CompileInput['texture'] = (name) => {
    name = name.replace(/^minecraft:/, '');

    if (textureCache.has(name)) {
      return textureCache.get(name)!;
    }

    const candidates = textureCandidates(name, names.mappings), path = candidates.find(value => images.has(value.path))?.path, image = images.get(path ?? '');
    let selected: ReturnType<CompileInput['texture']>;

    if (image) {
      selected = { path: path!, method: image.method, ...(image.height > image.width && image.height % image.width === 0 ? { uv: [0, 0, 1, image.width / image.height], warning: 'Animated texture uses its first frame' } : {}) };
    } else {
      const rectangle = atlas.rectangles[name];

      if (!rectangle) {
        throw new Error('Java sprite is absent from the extracted atlas: ' + name);
      }

      const [x, y, width, height] = rectangle, frame = height > width && height % width === 0 ? width : height;

      selected = { path: 'textures/physics_models/java_blocks', method: alphaMethod(png, rectangle), uv: [x / png.width, y / png.height, width / png.width, frame / png.height], warning: 'Java atlas texture fallback' };
    }

    textureCache.set(name, selected);

    return selected;
  };

  const compiled = compileModels({ source: { java: source.java.version, bedrock: states.version, mappings: source.mappings.version, revision }, states, mappings, models: java.models, blockstates: java.blockstates, texture });
  const inverse = buildInverse({ compiled: compiled.data, states, defaults, sources: inverseSources, mappings, models: java.models, blockstates: java.blockstates });
  const textures = buildTextureBindings({ compiled: compiled.data, models: java.models, mappings: names.mappings, images, atlas: atlas.image, rectangles: atlas.rectangles, native: textureSources });
  const renderers = buildRendererInputs({ java: source.java, runtime, resources: java, profile, names, minecraft: states.version });
  const definitions = await authoredDefinitions(definitionsDirectory);
  const proposed = supplementDocuments(compiled.data, resources, bindings, { inverse, textures, renderers, definitions });
  const audit = auditDocuments({ index: { minecraft: states.version }, lock: {}, documents: proposed.files }, resources);

  if (audit.errors.length) {
    throw new Error('Generated native references are invalid: ' + JSON.stringify(audit.errors.slice(0, 20)));
  }

  const previous = inputDirectory
    ? undefined
    : await readFile(join(output, 'coverage.json'), 'utf8').then(JSON.parse).catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
  const sourceLock = { schemaVersion: 1, minecraft: states.version, channel: source.bedrock.channel,
    upstream: { repository: source.bedrock.repository, tag: source.bedrock.tag, archive: source.bedrock.archive },
    conversion: { java: source.java.version, bedrock: states.version, mappings: source.mappings.version, revision,
      manifest: source.java.manifest, client: source.java.client, mappingArchive: source.mappings.archive,
      extraction: runtime.extractionRevision, nativeRevision: states.revision, ...(states.capture ? { nativeCapture: states.capture } : {}),
      inverse: inverseSources, renderers: renderers.source,
      sourcesSha256: hash(sourceBytes), textureRulesSha256: hash(jsonBytes(rules)) },
    authored: Object.fromEntries([...definitions].map(([file, document]) => [file, hash(JSON.stringify(document))])) };
  const licenses = { 'MOJANG-LICENSE.txt': license, 'GEYSER-LICENSE.txt': archive.get('LICENSE')!(),
    'JSPrismarine-LICENSE.txt': await readFile(join(directory, 'JSPrismarine-LICENSE.txt')), 'GEYSER-PACKCONVERTER-LICENSE.txt': await readFile(join(directory, 'GEYSER-PACKCONVERTER-LICENSE.txt')) };

  if (previous) {
    assertCoverageParity(previous, proposed.coverage);
  }

  const inputs: AssetInputFiles = {
    'sources.json': sourceBytes,
    'native-states.json': statesFile ? bytes(states) : stateBytes,
    'native-bindings.json': bindings.minecraft === originalBindings.minecraft ? bindingBytes : Buffer.from(JSON.stringify(bindings, null, 2) + '\n'),
    'renderer-profiles.json': profileBytes,
    'texture-rules.json': ruleBytes,
  };

  return { sourceLock, licenses, inputs, states, bindings, originalBindings, inverse, resources, previous, coverage: proposed.coverage, audit, documents: proposed.files, report: { minecraft: states.version, java: source.java.version, mappings: source.mappings.version, sourceRevision: revision,
    nativeDocuments: resources.size, javaBlocks: Object.keys(defaults.blocks).length, javaModels: Object.keys(java.models).length, rendererModels: Object.keys(renderers.models).length,
    sprites: java.sprites.size, textureNames: Object.keys(names.mappings).length, textureFaces: textures.statistics, documents: proposed.files.size,
    coveredStates: proposed.coverage.generatedBlockStates, auditErrors: audit.errors.length, auditGaps: audit.gaps.length } };
}

/** Compile in memory and write only final supplements and explicitly updated source inputs. */
export async function refreshAssets({ version, check = false, forceJava = false, statesFile, output = version ? releaseOutput(version) : distribution, ...options }: RefreshOptions = {}): Promise<RefreshReport> {
  const release = await readAssetRelease(version);
  const reportFile = version ? join(dirname(releaseOutput(version)), 'build.json') : join(reports, 'asset-maps-refresh.json');

  await mkdir(cache, { recursive: true });
  const lock = join(cache, 'refresh.lock'), owner = await open(lock, 'wx').catch((error) => {
    if (error.code === 'EEXIST') {
      throw new Error('An asset refresh is already running: ' + lock);
    }

    throw error;
  });

  await owner.writeFile(String(process.pid));
  await owner.close();

  try {
    const prepared = await prepareAssetRefresh({ ...options, version, output, forceJava: forceJava || check, statesFile });
    const generated = await writeDocuments({ ...prepared, ...options, output, check });

    if (!check && statesFile) {
      await writeFile(join(release.directory, 'native-states.json'), prepared.inputs['native-states.json']);

      if (prepared.bindings.minecraft !== prepared.originalBindings.minecraft) {
        await writeFile(join(release.directory, 'native-bindings.json'), prepared.inputs['native-bindings.json']);
      }
    }

    const report = { ...prepared.report, ...generated, version: release.version, outputPath: output };

    await mkdir(dirname(reportFile), { recursive: true });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');

    return report;
  } catch (error) {
    await mkdir(dirname(reportFile), { recursive: true });
    await writeFile(reportFile, JSON.stringify({ schemaVersion: 1, error: asError(error).message }, null, 2) + '\n');
    throw error;
  } finally { await unlink(lock); }
}

export function generationOptions(args: string[]): RefreshOptions {
  const options: RefreshOptions = {};

  for (let i = 0; i < args.length; i++) {
    const argument = args[i];

    if (argument === '--check') {
      options.check = true;
    } else if (argument === '--offline') {
      options.offline = true;
    } else if (argument === '--force-java') {
      options.forceJava = true;
    } else if (argument === '--version') {
      const value = args[++i];

      if (!value || value.startsWith('--')) {
        throw new Error('The --version option requires an Asset Maps version');
      }

      options.version = value;
    } else if (argument === '--states') {
      const file = args[++i];

      if (!file || file.startsWith('--')) {
        throw new Error('The --states option requires a file');
      }

      options.statesFile = file;
    } else if (argument === '--pretty' || argument === '--compact') {
      const pretty = argument === '--pretty';

      if (options.pretty !== undefined && options.pretty !== pretty) {
        throw new Error('Choose either --pretty or --compact');
      }

      options.pretty = pretty;
    } else { throw new Error('Unknown asset-map option: ' + argument); }
  }

  return options;
}
