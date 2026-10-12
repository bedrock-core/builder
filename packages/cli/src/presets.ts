import fs from 'fs-extra';
import path from 'node:path';

/** Full framework starter, plain Minecraft scripting starter, or resource-only starter. */
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

  for (const directory of ['packs/BP/guides', 'packs/BP/i18n', 'packs/BP/scripts', 'packs/BP/blocks', 'packs/BP/entities']) {
    await fs.remove(path.join(root, directory));
  }

  for (const file of ['tsconfig.test.json', 'packs/BP/manifest.test.json']) {
    await fs.remove(path.join(root, file));
  }

  delete config.bedrockCore.profiles.test;
  delete config.bedrockCore.profiles['build-test'];
  delete pkg.scripts['build:test'];
  delete pkg.scripts['watch:test'];
  pkg.dependencies = preset === 'script' ? { '@minecraft/server': pkg.dependencies['@minecraft/server'] } : {};
  delete pkg.devDependencies['@minecraft/server-gametest'];

  for (const profile of Object.values(config.bedrockCore.profiles) as { stages?: Record<string, unknown>; export: Record<string, string> }[]) {
    profile.stages = { 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false };

    if (preset === 'resource') {
      delete profile.export.behaviorPack;
    }
  }

  if (preset === 'resource') {
    await fs.remove(path.join(root, 'packs/BP'));
    delete config.packs.behaviorPack;
    const file = path.join(root, 'packs/RP/manifest.json');
    const manifest = await fs.readJson(file);

    delete manifest.dependencies;
    await fs.writeJson(file, manifest, { spaces: 2 });
    delete pkg.scripts.typecheck;
    await fs.writeJson(path.join(root, 'tsconfig.json'), { compilerOptions: { noEmit: true }, include: ['.bedrock-core/generated/**/*.d.ts'] }, { spaces: 2 });
  } else {
    const file = path.join(root, 'packs/BP/manifest.json');
    const manifest = await fs.readJson(file);

    manifest.modules = manifest.modules.filter((module: { type: string }) => module.type === 'script');
    manifest.dependencies = manifest.dependencies.filter((dependency: { pack?: string; module_name?: string }) => dependency.pack || dependency.module_name === '@minecraft/server');
    await fs.writeJson(file, manifest, { spaces: 2 });
    await fs.ensureDir(path.join(root, 'packs/BP/scripts'));
    await fs.writeFile(path.join(root, 'packs/BP/scripts/main.ts'), `import { world } from '@minecraft/server';\nimport { project } from '@bedrock-core/generated/project';\n\nworld.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {\n  if (initialSpawn) player.sendMessage(project.name);\n});\n`);
    const tsconfig = await fs.readJson(path.join(root, 'tsconfig.json'));

    delete tsconfig.compilerOptions.jsx;
    delete tsconfig.compilerOptions.jsxImportSource;
    tsconfig.include = ['packs/BP/scripts/**/*', '.bedrock-core/generated/**/*.d.ts'];
    await fs.writeJson(path.join(root, 'tsconfig.json'), tsconfig, { spaces: 2 });
  }

  await fs.writeJson(configFile, config, { spaces: 2 });
  await fs.writeJson(packageFile, pkg, { spaces: 2 });
  await fs.writeFile(path.join(root, 'README.md'), `# ${config.name}\n\n${config.description}\n\nRun the package manager's build command to export the packs. Shared display metadata is in config.json; package.json owns the version. UUIDs in the manifests are stable identities.\n`);
}
