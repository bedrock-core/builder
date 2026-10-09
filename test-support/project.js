import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manifestFor } from './manifest.js';

export async function projectFor(t, { cleanup = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-flow-'));
  const dispose = () => rm(root, { recursive: true, force: true });

  if (cleanup) {
    t.after(dispose);
  }

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
    name: 'Build flow', authors: [], targetVersion: '1.26.50',
    namespace: 'flow_test', packs: { gameplay: './packs/gameplay', visuals: './packs/visuals' },
    bedrockCore: { formatVersion: '1.0.0', profiles: {
      default: { stages: { manifest: true, bundler: { debug: true } }, export: { gameplay: './dist/gameplay', visuals: './dist/visuals' } },
      tests: {
        stages: { manifest: { packs: { gameplay: { scriptEntry: 'scripts/tests.js', header: { name: 'Test pack' } } } }, bundler: true },
        export: { gameplay: './dist-tests/gameplay', visuals: './dist-tests/visuals' },
      },
    } },
  };
  const configPath = path.join(project, 'config.json');

  await writeFile(configPath, JSON.stringify(config));

  return { root, project, behavior, resources, config, configPath, dispose };
}
