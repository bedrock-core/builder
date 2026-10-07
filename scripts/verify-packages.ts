import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTgz } from '../packages/generator/src/tar.ts';
import { yarn } from './yarn.ts';
// @ts-expect-error Test fixtures are JavaScript helpers outside the public API.
import { installUi } from '../test-support/ui.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(repository, '.bedrock-core/release/tarballs');
const packages = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')) as { name: string; version: string; file: string }[];
const root = await mkdtemp(path.join(tmpdir(), 'builder-package-check-'));
const files = Object.fromEntries(packages.map(pkg => [pkg.name, `file:${path.join(directory, pkg.file).replaceAll('\\', '/')}`]));

try {
  for (const pkg of packages) {
    const contents = extractTgz(await readFile(path.join(directory, pkg.file)));
    const metadata = JSON.parse(contents.get('package/package.json')!.toString()) as { exports: Record<string, unknown>; dependencies?: Record<string, string> };

    assert.ok(Object.values(metadata.dependencies ?? {}).every(version => !version.startsWith('workspace:')));
    assert.ok(!JSON.stringify(metadata.exports).includes('/src/index.ts'));
    assert.ok([...contents.keys()].every(file => !file.includes('/node_modules/') && !file.includes('/.bedrock-core/')));
  }

  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'builder-package-check', private: true, type: 'module', packageManager: 'yarn@4.16.0',
    dependencies: { '@bedrock-core/builder': files['@bedrock-core/builder'], 'typescript': '5.9.3' }, resolutions: files,
  }, null, 2));
  await writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\nenableGlobalCache: true\n');
  yarn(['install'], root);
  await cp(path.join(repository, 'fixtures/acceptance'), path.join(root, 'addon'), { recursive: true });
  await installUi(path.join(root, 'addon'));
  await writeFile(path.join(root, 'addon/packs/BP/scripts/acceptance.screen.tsx'), `
    import { Screen, Text } from '@bedrock-core/ui';
    export default function Page() { return <Screen><Text>Installed UI compiler</Text></Screen>; }
  `);
  await mkdir(path.join(root, 'addon/ui'));
  await writeFile(path.join(root, 'addon/ui/empty.mjs'), 'export default {};');
  await writeFile(path.join(root, 'verify.mjs'), `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    import { runBuild } from '@bedrock-core/builder/runner';
    import { validateConfig } from '@bedrock-core/builder/config';
    import { readUiDeclaration } from '@bedrock-core/builder-ui';
    import { bundleScripts } from '@bedrock-core/builder-bundler';
    import { compileI18n } from '@bedrock-core/builder-i18n';
    import { compileGuides } from '@bedrock-core/builder-guides';
    import { generateTemplates } from '@bedrock-core/builder-generator';
    import { validatePackContent } from '@bedrock-core/builder-validation';
    assert.equal(typeof bundleScripts, 'function');
    assert.equal(typeof compileI18n, 'function');
    assert.equal(typeof compileGuides, 'function');
    assert.equal(typeof generateTemplates, 'function');
    assert.equal(typeof validatePackContent, 'function');
    validateConfig(JSON.parse(await readFile('addon/config.json', 'utf8')));
    await readUiDeclaration(path.resolve('addon/ui/empty.mjs'));
    const result = await runBuild({ configPath: 'addon/config.json', logger: {} });
    assert.equal(result.packs.length, 3);
    assert.ok(result.validation.files.some(file => file.schema));
    assert.equal(result.stages.find(stage => stage.stage === 'ui-compiler').status, 'executed');
    const cached = await runBuild({ configPath: 'addon/config.json', logger: {} });
    assert.ok(cached.compilations.every(item => item.status === 'cached'));
  `);
  const runtime = spawnSync(process.execPath, ['verify.mjs'], { cwd: root, stdio: 'inherit' });

  assert.equal(runtime.status, 0, 'Installed package APIs and worker must run using plain Node');
  await writeFile(path.join(root, 'types.ts'), `
    import { runBuild, type BuildOptions } from '@bedrock-core/builder/runner';
    import type { BundleOptions } from '@bedrock-core/builder-bundler';
    import type { GuidesOptions } from '@bedrock-core/builder-guides';
    import type { ContentValidationOptions } from '@bedrock-core/builder-validation';
    export { runBuild };
    export type Options = BuildOptions | BundleOptions | GuidesOptions | ContentValidationOptions;
  `);
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: 'NodeNext', target: 'ES2023', types: ['node'], skipLibCheck: false },
    files: ['types.ts'],
  }));
  yarn(['tsc', '--noEmit'], root);
  const cli = spawnSync(process.execPath, ['node_modules/@bedrock-core/builder/dist/bin/builder.js', '--help'], { cwd: root, encoding: 'utf8' });

  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /bc-build/);

  for (const pkg of packages.filter(pkg => pkg.name !== '@bedrock-core/builder')) {
    const standalone = await mkdtemp(path.join(tmpdir(), 'builder-standalone-check-'));

    try {
      await writeFile(path.join(standalone, 'package.json'), JSON.stringify({
        name: 'builder-standalone-check', private: true, type: 'module', packageManager: 'yarn@4.16.0',
        dependencies: { [pkg.name]: files[pkg.name] }, resolutions: files,
      }));
      await writeFile(path.join(standalone, '.yarnrc.yml'), 'nodeLinker: node-modules\nenableGlobalCache: true\n');
      yarn(['install'], standalone);
      await writeFile(path.join(standalone, 'verify.mjs'), `await import(${JSON.stringify(pkg.name)});`);
      const result = spawnSync(process.execPath, ['verify.mjs'], { cwd: standalone, stdio: 'inherit' });

      assert.equal(result.status, 0, `${pkg.name} must load with only its declared dependencies`);
    } finally {
      await rm(standalone, { recursive: true, force: true });
    }
  }

  const integrities: Record<string, string> = {};

  for (const pkg of packages) {
    integrities[pkg.name] = `sha512-${createHash('sha512').update(await readFile(path.join(directory, pkg.file))).digest('base64')}`;
  }

  await writeFile(path.join(directory, 'verified.json'), `${JSON.stringify({ node: process.versions.node, integrities }, null, 2)}\n`);
  console.log('@bedrock-core/builder: installed release APIs, CLI, workers and declarations passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
