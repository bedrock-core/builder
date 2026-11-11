import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manifestFor } from './manifest.js';

export async function put(root, relative, content) {
  const file = path.join(root, relative);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);

  return file;
}

export async function projectFor(t, { cleanup = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'builder-flow-')));
  const dispose = () => rm(root, { recursive: true, force: true });

  if (cleanup) {
    t.after(dispose);
  }

  const project = path.join(root, 'project');
  const behavior = manifestFor('script', 'scripts/main.ts');
  const resources = manifestFor('resources');

  behavior.namespace = 'flow_test';
  resources.namespace = 'flow_test';

  behavior.dependencies = [{ uuid: resources.header.uuid, version: resources.header.version }];

  await mkdir(path.join(project, 'packs/gameplay/scripts'), { recursive: true });
  await mkdir(path.join(project, 'packs/visuals'), { recursive: true });
  await writeFile(path.join(project, 'packs/gameplay/manifest.json'), JSON.stringify(behavior));
  await writeFile(path.join(project, 'packs/gameplay/manifest.test.json'), JSON.stringify({
    extends: './manifest.json',
    header: { name: 'Test pack' },
    modules: behavior.modules.map(module => ({ ...module, entry: 'scripts/tests.ts' })),
  }));
  await writeFile(path.join(project, 'packs/visuals/manifest.json'), JSON.stringify(resources));
  await writeFile(path.join(project, 'packs/gameplay/scripts/main.ts'), 'export const value: number = 1;');
  await writeFile(path.join(project, 'packs/gameplay/scripts/tests.ts'), 'export const value: number = 99;');
  await writeFile(path.join(project, 'packs/visuals/asset.json'), '{"value":1}');
  const config = {
    name: 'Build flow', authors: [], targetVersion: '1.26.50',
    packs: { gameplay: './packs/gameplay', visuals: './packs/visuals' },
    bedrockCore: { formatVersion: '1.0.0', profiles: {
      default: { stages: { manifest: true, bundler: { debug: true } }, export: { gameplay: './dist/gameplay', visuals: './dist/visuals' } },
      tests: {
        stages: { manifest: { manifestPath: './packs/gameplay/manifest.test.json' }, bundler: true },
        export: { gameplay: './dist-tests/gameplay', visuals: './dist-tests/visuals' },
      },
    } },
  };
  const configPath = path.join(project, 'config.json');

  await writeFile(configPath, JSON.stringify(config));

  return { root, project, behavior, resources, config, configPath, dispose };
}
