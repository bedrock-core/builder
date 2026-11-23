import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assetMapsIndex, generateVanillaAssets } from '../packages/bundler/src/vanilla.ts';
import type { MinecraftTarget } from './minecraft-state-capture.ts';
import { yarn } from './yarn.ts';

const [archives, output] = process.argv.slice(2);

assert(archives && output, 'Usage: node scripts/minecraft-acceptance.ts <archives> <dependency-root>');
const target = JSON.parse(process.env.COMPATIBILITY_ROW ?? 'null') as MinecraftTarget | { id: 'locked'; apiChannel: 'locked' };
const plan = JSON.parse(await readFile(path.join(archives, 'packages.json'), 'utf8')) as {
  packages: Record<string, Record<string, { file: string; version: string }>>;
};
const candidates = plan.packages[target.id];
const fixture = JSON.parse(await readFile('fixtures/acceptance/package.json', 'utf8')) as { name: string; dependencies: Record<string, string> };
const { packageManager } = JSON.parse(await readFile('package.json', 'utf8')) as { packageManager: string };
const npmPath = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : undefined;
const npm = (args: string[]): string => execFileSync(npmPath ? process.execPath : 'npm', npmPath ? [npmPath, ...args] : args, {
  cwd: output, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
});

await mkdir(output, { recursive: true });

if (target.apiChannel !== 'locked') {
  Object.assign(fixture.dependencies, target.packages);
  const common = npm(['view', '@minecraft/server@' + target.packages['@minecraft/server'], 'dependencies', '--json', '--registry', 'https://registry.npmjs.org']);
  const dependencies = common ? JSON.parse(common) as Record<string, string> : {};

  if (dependencies['@minecraft/common']) {
    fixture.dependencies['@minecraft/common'] = dependencies['@minecraft/common'];
  }
}

for (const [name, candidate] of Object.entries(candidates)) {
  assert.equal(candidate.file, `bedrock-core-${name}-${candidate.version}.tgz`);
  fixture.dependencies['@bedrock-core/' + name] = 'file:' + path.resolve(archives, candidate.file);
}

await Promise.all([
  writeFile(path.join(output, 'package.json'), JSON.stringify({ ...fixture, packageManager }, null, 2) + '\n'),
  cp('.yarnrc.yml', path.join(output, '.yarnrc.yml')),
  appendFile(path.join(output, 'yarn.lock'), ''),
]);
yarn(['install'], output, { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', YARN_ENABLE_SCRIPTS: 'false' });

for (const [name, candidate] of Object.entries(candidates)) {
  const installed = JSON.parse(await readFile(path.join(output, 'node_modules', '@bedrock-core', name, 'package.json'), 'utf8')) as { version: string };

  assert.equal(installed.version, candidate.version, 'Installation must use the candidate ' + name + ' archive');
}

if (target.apiChannel !== 'locked') {
  for (const [name, version] of Object.entries(target.packages)) {
    const installed = JSON.parse(await readFile(path.join(output, 'node_modules', name, 'package.json'), 'utf8')) as { version: string };

    assert.equal(installed.version, version, 'Installed SDK must match the resolved Minecraft row: ' + name);
  }
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, 'installed=true\ntypes=' + (candidates['bedrock-types']?.version ?? '') + '\n');
}

if (target.apiChannel !== 'locked' && candidates['asset-maps']) {
  const maps = await generateVanillaAssets({ mapsIndex: assetMapsIndex(output), targetVersion: target.engineVersion, dependencyRoot: output });

  assert(maps.catalog?.models && Object.keys(maps.catalog.models).length, maps.unavailable ?? 'The installed Asset Maps must compose with Mojang Samples');
}
