import fs from 'fs-extra';
import path from 'node:path';

/** Full framework starter, behavior-only scripting starter, or resource-only starter. */
export type ProjectPreset = 'full' | 'script' | 'resource';

/** Apply a preset only to the newly copied project directory. */
export async function applyPreset(root: string, preset: ProjectPreset): Promise<void> {
  if (preset === 'full') {
    return;
  }

  const configFile = path.join(root, 'config.json');
  const config = await fs.readJson(configFile);
  const packageFile = path.join(root, 'package.json');
  const pkg = await fs.readJson(packageFile);

  for (const directory of ['packs/BP/guides', 'packs/BP/i18n', 'packs/BP/scripts/UI', 'packs/BP/blocks', 'packs/BP/entities']) {
    await fs.remove(path.join(root, directory));
  }

  await fs.remove(path.join(root, 'packs/BP/scripts/config.ts'));
  pkg.dependencies = preset === 'script'
    ? Object.fromEntries(['@minecraft/common', '@minecraft/server', '@minecraft/vanilla-data'].map(name => [name, pkg.dependencies[name]]))
    : {};

  for (const profile of Object.values(config.bedrockCore.profiles) as { stages?: Record<string, unknown>; export: Record<string, string> }[]) {
    profile.stages = { ...profile.stages, 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false };
    delete profile.export[preset === 'script' ? 'resourcePack' : 'behaviorPack'];
  }

  if (preset === 'resource') {
    await fs.remove(path.join(root, 'packs/BP'));
    await fs.remove(path.join(root, 'tsconfig.test.json'));
    delete config.packs.behaviorPack;
    delete config.bedrockCore.profiles.test;
    delete config.bedrockCore.profiles['build-test'];
    delete pkg.scripts['build:test'];
    delete pkg.scripts['watch:test'];
    delete pkg.scripts['test:mc'];
    delete pkg.scripts.typecheck;
    delete pkg.devDependencies['@minecraft/server-gametest'];
    const file = path.join(root, 'packs/RP/manifest.json');
    const manifest = await fs.readJson(file);

    delete manifest.dependencies;

    if (manifest.metadata) {
      delete manifest.metadata.product_type;
    }

    await fs.writeJson(file, manifest, { spaces: 2 });
    await fs.writeJson(path.join(root, 'tsconfig.json'), { compilerOptions: { noEmit: true }, include: ['.bedrock-core/generated/**/*.d.ts'] }, { spaces: 2 });
  } else {
    await fs.remove(path.join(root, 'packs/RP'));
    delete config.packs.resourcePack;

    for (const name of ['manifest.json', 'manifest.test.json']) {
      const file = path.join(root, 'packs/BP', name);
      const manifest = await fs.readJson(file);

      manifest.dependencies = manifest.dependencies.filter((dependency: { module_name?: string }) =>
        dependency.module_name === '@minecraft/server' || dependency.module_name === '@minecraft/server-gametest');
      await fs.writeJson(file, manifest, { spaces: 2 });
    }

    await fs.writeFile(path.join(root, 'packs/BP/scripts/main.ts'), `import { world } from '@minecraft/server';
import { project } from '@bedrock-core/generated/project';

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) player.sendMessage(project.name);
});
`);
    const tsconfig = await fs.readJson(path.join(root, 'tsconfig.json'));

    delete tsconfig.compilerOptions.jsx;
    delete tsconfig.compilerOptions.jsxImportSource;
    tsconfig.include = ['packs/BP/scripts/**/*', '.bedrock-core/generated/**/*.d.ts'];
    await fs.writeJson(path.join(root, 'tsconfig.json'), tsconfig, { spaces: 2 });
  }

  await fs.writeJson(configFile, config, { spaces: 2 });
  await fs.writeJson(packageFile, pkg, { spaces: 2 });
  const testing = preset === 'script' ? ' Run test:mc for the included headless GameTest.' : '';

  await fs.writeFile(path.join(root, 'README.md'), `# ${config.name}

${config.description}

Run build to export the pack, watch to rebuild during development, and build:optimized to produce optimized distribution output.${testing}

https://bedrock-core.drav.dev/docs/cli
`);
}
