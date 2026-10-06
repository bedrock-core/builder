import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manifestFor } from './manifest.js';

export async function projectFor(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-flow-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const behavior = manifestFor('script');
  const resources = manifestFor('resources');

  await mkdir(path.join(project, 'packs/gameplay/scripts'), { recursive: true });
  await mkdir(path.join(project, 'packs/visuals'), { recursive: true });
  await writeFile(path.join(project, 'packs/gameplay/manifest.json'), JSON.stringify(behavior));
  await writeFile(path.join(project, 'packs/visuals/manifest.json'), JSON.stringify(resources));
  await writeFile(path.join(project, 'packs/gameplay/scripts/main.ts'), 'export const value: number = 1;');
  await writeFile(path.join(project, 'packs/gameplay/scripts/tests.ts'), 'export const value: number = 99;');
  await writeFile(path.join(project, 'packs/visuals/asset.json'), '{"value":1}');
  const config = {
    type: 'minecraftBedrock', name: 'Build flow', authors: [], targetVersion: '1.26.50',
    namespace: 'flow_test', worlds: [], packs: { gameplay: './packs/gameplay', visuals: './packs/visuals' },
    bedrockCore: { formatVersion: '1.0.0', profiles: {
      default: { stages: { manifest: true, bundler: { debug: true } }, export: { path: './dist' } },
      tests: {
        stages: { manifest: { packs: { gameplay: { scriptEntry: 'scripts/tests.js', header: { name: 'Test pack' } } } }, bundler: true },
        export: { path: './dist-tests' },
      },
    } },
  };
  const configPath = path.join(project, 'config.json');

  await writeFile(configPath, JSON.stringify(config));

  return { root, project, behavior, resources, config, configPath };
}
