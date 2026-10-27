import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UiSettings } from './types.ts';
import { patchOreInputBundle } from './ore-input.ts';
const packPng = /^pack:\/\/(textures\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.png)$/;
const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const inside = (root: string, file: string): boolean => file.startsWith(root + path.sep);
const absent = (error: unknown): boolean => ['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Read the Bedrock version encoded by the stable Windows client manifest. */
export function oreClientVersion(manifest: string): string {
  const identity = manifest.match(/<Identity\b([^>]+)>/i)?.[1] ?? '';
  const name = identity.match(/\bName="([^"]+)"/i)?.[1];
  const version = identity.match(/\bVersion="(\d+)\.(\d+)\.(\d+)\.\d+"/i);

  assert(name?.toLowerCase() === 'microsoft.minecraftuwp' && version, 'Expected a Windows Minecraft client manifest');

  return `${version[1]}.${version[2]}.${Math.floor(Number(version[3]) / 100)}.${Number(version[3]) % 100}`;
}

export interface OreClient {
  root: string;
  version: string;
  entry: string;
  files: string[];
}

async function clientAt(root: string, target?: string): Promise<OreClient> {
  const manifest = path.join(root, 'appxmanifest.xml');
  const version = oreClientVersion(await readFile(manifest, 'utf8'));

  assert(!target || version === target || version.startsWith(target + '.'), `Ore client ${version} does not match targetVersion ${target}`);
  const entryFile = path.join(root, 'data/gui/dist/hbui/gameplay.html');
  const entry = await readFile(entryFile, 'utf8');
  const files = [manifest, entryFile];

  for (const match of entry.matchAll(/(?:src|href)=["'](\/hbui\/[^"']+)["']/g)) {
    assert(!match[1].includes('..') && !match[1].includes('\\'), 'Invalid native Ore bundle reference');
    files.push(path.join(root, 'data/gui/dist', match[1]));
  }

  files.push(path.join(root, 'data/fonts/Mojangles.ttf'), path.join(root, 'data/resource_packs/vanilla/font/minecraft-ten.ttf'));
  await Promise.all(files.map(file => stat(file)));

  return { root, version, entry, files };
}

/** Resolve an explicit client or unambiguous installed assets for the configured release. */
export async function findOreClient(projectRoot: string, target: string | undefined, clientRoot?: string, searchRoots = ['C:/XboxGames', 'C:/Program Files/WindowsApps']): Promise<OreClient> {
  if (clientRoot) {
    return clientAt(path.resolve(projectRoot, clientRoot), target);
  }

  assert(target, 'Set experimentalOre.clientRoot when the build has no targetVersion');
  const candidates: OreClient[] = [];

  for (const directory of searchRoots) {
    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (absent(error)) {
        continue;
      }

      throw error;
    }

    for (const entry of entries.filter(entry => entry.isDirectory())) {
      for (const suffix of ['Content', '']) {
        const root = path.join(directory, entry.name, suffix);

        try {
          const manifest = await readFile(path.join(root, 'appxmanifest.xml'), 'utf8');

          if (!/\bName="Microsoft\.MinecraftUWP"/i.test(manifest)) {
            continue;
          }

          const version = oreClientVersion(manifest);

          if (version !== target && !version.startsWith(target + '.')) {
            continue;
          }

          candidates.push(await clientAt(root, target));
        } catch (error) {
          if (!absent(error)) {
            throw error;
          }
        }
      }
    }
  }

  assert(candidates.length, `No complete Minecraft ${target} client found; set experimentalOre.clientRoot`);
  assert(new Set(candidates.map(candidate => hash(candidate.entry))).size === 1, 'Different installed Ore entry pages found; set experimentalOre.clientRoot');

  return candidates[0];
}

/** Keep vanilla root/bundle tags and install the adapter plus an independent startup diagnostic. */
export function injectOreEntry(original: string): string {
  assert.match(original, /id=["']root["']/);
  assert.match(original, /gameplay[^"'<>]*\.js/);
  assert.match(original, /<\/body\s*>/i);
  assert(!original.includes('core-ore-client.js') && !original.includes('core-ore-bootstrap'), 'Use the unmodified installed entry page');
  const badge = '<div id="core-ore-bootstrap" style="position:fixed;right:12px;top:12px;max-width:460px;padding:10px;background:#172028;color:white;border:1px solid #83cda0;font:14px sans-serif;z-index:2147481000;pointer-events:none;">Custom UI entry loaded; starting script</div>';
  const watchdog = '<script>window.setTimeout(function(){if(!window.__coreOreInstalled){var b=document.getElementById("core-ore-bootstrap");if(b)b.textContent="Custom UI entry loaded, but the adapter script did not start";}},3500);</script>';

  return original.replace(/<\/body\s*>/i, badge + watchdog + '<script src="/hbui/core-ore-client.js"></script></body>');
}

export interface OreTextureMetadata {
  size: [
    number,
    number,
  ];
  base?: [
    number,
    number,
  ];
  slice?: [
    number,
    number,
    number,
    number,
  ];
}

/** Read PNG dimensions and Bedrock's logical left/top/right/bottom slice metadata. */
export function oreTextureMetadata(png: Buffer, sidecar?: {
  nineslice_size?: unknown;
  base_size?: unknown;
}): OreTextureMetadata {
  assert(png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.toString('ascii', 12, 16) === 'IHDR', 'Expected a PNG texture');
  const size: [
    number,
    number,
  ] = [png.readUInt32BE(16), png.readUInt32BE(20)];

  assert(size.every(value => value > 0), 'Invalid PNG dimensions');

  if (sidecar?.nineslice_size === undefined) {
    return { size };
  }

  const value = sidecar.nineslice_size;
  const slice: unknown = typeof value === 'number' ? [value, value, value, value] : Array.isArray(value) && value.length === 2 ? [...value, ...value] : value;
  const base = sidecar.base_size ?? size;

  assert(Array.isArray(slice) && slice.length === 4 && slice.every(value => Number.isFinite(value) && value >= 0), 'Invalid nine-slice insets');
  assert(Array.isArray(base) && base.length === 2 && base.every(value => Number.isFinite(value) && value > 0), 'Invalid nine-slice base size');
  assert(slice[0] + slice[2] <= base[0] && slice[1] + slice[3] <= base[1], 'Nine-slice insets exceed the base size');

  return { size, base: base as [
    number,
    number,
  ], slice: slice as [
    number,
    number,
    number,
    number,
  ] };
}

interface AssetLayout {
  schema: string;
  background?: string;
  nodes: {
    source?: string;
    resources?: string[];
    backgrounds?: Record<string, string>;
    field?: { surfaces?: Record<string, string> };
  }[];
  textures?: Record<string, OreTextureMetadata>;
}
export interface OreAssetOptions {
  pack: string;
  projectRoot: string;
  stagedRoot: string;
  targetVersion?: string;
  layouts: string[];
  settings?: UiSettings['experimentalOre'];
  registerDependency(file: string): void;
}

/** Prepare only selected Ore layouts in the staged RP; authored/client roots remain read-only. */
export async function prepareOreAssets(options: OreAssetOptions): Promise<{
  files: string[];
  version: string;
}> {
  const { pack, projectRoot, stagedRoot, layouts, registerDependency } = options;
  const client = await findOreClient(projectRoot, options.targetVersion, options.settings?.clientRoot);
  const roots = [await realpath(pack), ...await Promise.all((options.settings?.resourceRoots ?? []).map(root => realpath(path.resolve(projectRoot, root))))];
  const files = new Set<string>();
  const metadata = new Map<string, OreTextureMetadata>();
  let liveInputs = false;

  client.files.forEach(registerDependency);

  function dependency(file: string): void {
    registerDependency(inside(stagedRoot, file) ? path.resolve(projectRoot, path.relative(stagedRoot, file)) : file);
  }

  async function texture(source: string): Promise<OreTextureMetadata> {
    assert.match(source, packPng, 'Expected a pack-local PNG reference');
    const name = source.match(packPng)![1];
    let selected: string | undefined;
    let selectedRoot = '';

    for (const root of roots) {
      const file = path.join(root, name);

      dependency(file);

      try {
        const resolved = await realpath(file);

        assert(inside(root, resolved), `Ore texture escapes its resource root: ${name}`);
        selected = file;
        selectedRoot = root;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    assert(selected, `Missing Ore texture ${name}; supply it in the selected RP or experimentalOre.resourceRoots`);
    const png = await readFile(selected);
    const sidecarFile = selected.replace(/\.png$/, '.json');
    let sidecar: {
      nineslice_size?: unknown;
      base_size?: unknown;
    } | undefined;

    dependency(sidecarFile);

    try {
      assert(inside(selectedRoot, await realpath(sidecarFile)), `Ore sidecar escapes its resource root: ${name}`);
      sidecar = JSON.parse(await readFile(sidecarFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const output = path.join(pack, name);

    await mkdir(path.dirname(output), { recursive: true });

    if (path.resolve(selected) !== path.resolve(output)) {
      await writeFile(output, png);
    }

    files.add(output);

    if (sidecar !== undefined) {
      const destination = output.replace(/\.png$/, '.json');

      if (path.resolve(sidecarFile) !== path.resolve(destination)) {
        await copyFile(sidecarFile, destination);
      }

      files.add(destination);
    }

    return oreTextureMetadata(png, sidecar);
  }

  for (const relative of layouts) {
    assert(/^hbui\/core-ore\/[A-Za-z0-9_-]+\.json$/.test(relative), 'Invalid Ore layout path');
    const file = path.join(pack, relative);
    const layout = JSON.parse(await readFile(file, 'utf8')) as AssetLayout;

    assert(layout.schema === 'core-ore-layout/1' && Array.isArray(layout.nodes), 'Invalid Ore asset layout');
    liveInputs ||= layout.nodes.some(node => node.field !== undefined);
    const backgrounds = new Set([...layout.background ? [layout.background] : [], ...layout.nodes.flatMap(node => [...Object.values(node.backgrounds ?? {}), ...Object.values(node.field?.surfaces ?? {}), ...node.resources ?? []])]);
    const dynamic = (options.settings?.dynamicTextures ?? []).map(source => `pack://${source.endsWith('.png') ? source : source + '.png'}`);
    const sources = new Set([...backgrounds, ...dynamic, ...layout.nodes.flatMap(node => node.source ? [node.source] : [])]);

    for (const source of sources) {
      if (!metadata.has(source)) {
        metadata.set(source, await texture(source));
      }
    }

    layout.textures = Object.fromEntries([...backgrounds].map(source => [source, metadata.get(source)!]));
    await writeFile(file, JSON.stringify(layout));
    files.add(file);
  }

  const entry = path.join(pack, 'hbui/gameplay.html');

  try {
    await stat(entry);
    throw new Error('Experimental Ore cannot replace an authored hbui/gameplay.html');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await writeFile(entry, injectOreEntry(client.entry));
  files.add(entry);

  let inputBridge: { schema: string; bundle: string; sourceSha256: string; outputSha256: string } | undefined;

  if (liveInputs) {
    const bundles = client.files.filter(file => file.endsWith('.js'));

    assert.equal(bundles.length, 1, 'Live Ore inputs require one native gameplay bundle');
    const source = await readFile(bundles[0], 'utf8');
    const output = patchOreInputBundle(source);
    const bundle = `hbui/${path.basename(bundles[0])}`;
    const destination = path.join(pack, bundle);

    try {
      await stat(destination);
      throw new Error(`Experimental Ore cannot replace an authored ${bundle}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    await writeFile(destination, output);
    files.add(destination);
    inputBridge = { schema: 'core-ore-native-input/1', bundle, sourceSha256: hash(source), outputSha256: hash(output) };
    const license = bundles[0] + '.LICENSE.txt';

    registerDependency(license);

    try {
      const destinationLicense = destination + '.LICENSE.txt';

      await copyFile(license, destinationLicense);
      files.add(destinationLicense);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  for (const [source, name] of [['data/fonts/Mojangles.ttf', 'mojangles.ttf'], ['data/resource_packs/vanilla/font/minecraft-ten.ttf', 'minecraft-ten.ttf']]) {
    const destination = path.join(pack, 'hbui/core-ore/fonts', name);

    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(client.root, source), destination);
    files.add(destination);
  }

  const report = path.join(pack, 'bedrock-core/experimental-ore.json');

  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(report, JSON.stringify({ schema: 'core-ore-assets/1', clientVersion: client.version, entrySha256: hash(client.entry), textures: [...metadata.keys()], ...inputBridge ? { inputBridge } : {} }));
  files.add(report);

  return { files: [...files], version: client.version };
}
