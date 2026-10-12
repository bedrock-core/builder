import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { projectFor } from './project.js';
import { installUi } from './ui.js';
import { put } from './i18n.js';

export async function guidesFor(t, { screens = false, cleanup = true } = {}) {
  const project = await projectFor(t, { cleanup });

  project.config.bedrockCore.profiles.default.stages = screens ? {} : { guides: { compileScreens: false } };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await put(project.project, 'packs/gameplay/guides/en_US/start.mdx', '# Start\n\nRead [the next page](./next).\n');
  await put(project.project, 'packs/gameplay/guides/en_US/next.md', '# Next\n\nMore information.\n');

  return project;
}

export function guidesOptions(project, settings = {}) {
  return {
    root: project.project, sourceDir: 'packs/gameplay/guides', namespace: 'flow_test', compileScreens: false,
    packs: [{ path: 'packs/visuals', kind: 'resource' }, { path: 'packs/gameplay', kind: 'behavior' }],
    ...settings,
  };
}

/** Small addon-installed guide factories exercising automatic pipeline handoffs. */
export async function installGuides(root) {
  await installUi(root);
  await put(root, 'package.json', JSON.stringify({ type: 'module', dependencies: { '@bedrock-core/guides': '0.0.0' } }));
  await put(root, 'node_modules/@bedrock-core/guides/package.json', JSON.stringify({
    name: '@bedrock-core/guides', type: 'module', exports: './index.js',
    bedrockCore: { i18n: { dir: 'i18n', namespace: 'core' } },
  }));
  await put(root, 'node_modules/@bedrock-core/guides/i18n/en_US.ts', 'export default { guides: { adm: { note: "Note" } } };');
  await put(root, 'node_modules/@bedrock-core/guides/index.js', `
    import { Screen, Text } from '@bedrock-core/ui';
    export const openGuide = () => Date.now();
    export const guidePageScreen = (manifest, page) => () => Screen({ children: Text({ children: manifest.pages[page] }) });
    export const guideHomeScreen = manifest => () => Screen({ children: Text({ children: manifest.home ?? manifest.tree }) });
    export const guideIndexScreen = manifest => () => Screen({ children: Text({ children: manifest.tree }) });
  `);
}

export async function exportedModule(result) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8');

  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
