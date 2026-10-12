import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTgz } from '../packages/generator/src/tar.ts';
import { yarn } from './yarn.ts';
import { validateConfig } from '../src/config.ts';
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
    const metadata = JSON.parse(contents.get('package/package.json')!.toString()) as { exports?: Record<string, unknown>; dependencies?: Record<string, string> };
    const exports = metadata.exports ?? {};

    assert.ok(Object.values(metadata.dependencies ?? {}).every(version => !version.startsWith('workspace:')));
    assert.ok(!JSON.stringify(exports).includes('/src/index.ts'));
    assert.ok(Object.keys(exports).every(entry => !entry.includes('*')), `${pkg.name} must list its export paths explicitly`);
    assert.ok([...contents.keys()].every(file => !file.includes('/node_modules/') && !file.includes('/.bedrock-core/')));

    if (pkg.name === '@bedrock-core/cli') {
      assert.ok(contents.has('package/dist/index.js'));
      assert.ok(contents.has('package/templates/bedrock-core/config.json'));
      assert.ok(contents.has('package/templates/bedrock-core/gitignore'));
      assert.ok(contents.has('package/templates/bedrock-core/yarnrc.yml'));
      assert.ok(contents.has('package/templates/bedrock-core/packs/BP/guides/en_US/intro.mdx'));
      assert.ok([...contents.keys()].every(file => !file.startsWith('package/templates/bedrock-core/guides/')));
      assert.ok(contents.has('package/templates/bedrock-core/packs/BP/structures/example/the_addon_loads.mcstructure'));
    }
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
  await writeFile(path.join(root, 'verify.mjs'), `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { readFile } from 'node:fs/promises';
    import { runBuild } from '@bedrock-core/builder/runner';
    import { validateConfig } from '@bedrock-core/builder/config';
    import * as uiOptions from '@bedrock-core/builder-ui';
    import { bundleScripts } from '@bedrock-core/builder-bundler';
    import { compileI18n } from '@bedrock-core/builder-i18n';
    import { compileGuides } from '@bedrock-core/builder-guides';
    import { generateTemplates } from '@bedrock-core/builder-generator';
    import { validatePackContent } from '@bedrock-core/builder-validation';
    import { fingerprint } from '@bedrock-core/builder-plugin';
    import { resolveManifest } from '@bedrock-core/builder-manifest';
    assert.equal(typeof bundleScripts, 'function');
    assert.equal(typeof compileI18n, 'function');
    assert.equal(typeof compileGuides, 'function');
    assert.equal(typeof generateTemplates, 'function');
    assert.equal(typeof validatePackContent, 'function');
    assert.equal(typeof fingerprint, 'function');
    assert.equal(typeof resolveManifest, 'function');
    for (const name of ['manifest', 'generator', 'guides', 'i18n', 'ui', 'bundler']) {
      const plugin = await import('@bedrock-core/builder-' + name + '/plugin');
      assert.equal(typeof plugin.run, 'function');
      assert.equal(typeof plugin.detect, 'function');
    }
    assert.deepEqual(Object.keys(uiOptions), []);
    const require = createRequire(import.meta.url);
    for (const name of ${JSON.stringify(packages.filter(pkg => pkg.name !== '@bedrock-core/cli').map(pkg => pkg.name))}) {
      assert.throws(() => require.resolve(name + '/internal/index'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    }
    validateConfig(JSON.parse(await readFile('addon/config.json', 'utf8')));
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
    import type { GuidesOptions, GuideManifest } from '@bedrock-core/builder-guides';
    import guides from '@bedrock-core/generated/guides/logic';
    import type { ContentValidationOptions } from '@bedrock-core/builder-validation';
    import type { UiSettings } from '@bedrock-core/builder-ui';
    import type { BuildPlugin, BuildContext, BundleExtension } from '@bedrock-core/builder-plugin';
    import * as generatorPlugin from '@bedrock-core/builder-generator/plugin';
    const plugin: BuildPlugin = generatorPlugin;
    const extension: BundleExtension = { id: 'example:types', version: '1', plugins: [{ name: 'typed', setup(build) { build.onLoad({ filter: /example/ }, () => ({ contents: '', loader: 'js' })); } }] };
    async function useContext(context: BuildContext) {
      context.registerBundleExtension(extension);
      const result = await context.reuse('example', { inputs: [], key: '1', run: () => ({ value: { count: 1 } }) });
      const count: number = result.value.count;
      return count;
    }
    const guideManifest: GuideManifest = guides;
    const guideOptions: GuidesOptions = { root: '.', namespace: 'example', moduleName: '@bedrock-core/generated/guides/example', section: 'example' };
    export { plugin, extension, useContext, guideManifest, guideOptions };
    export { runBuild };
    export type Options = BuildOptions | BundleOptions | GuidesOptions | ContentValidationOptions | UiSettings;
  `);
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: 'NodeNext', target: 'ES2023', types: ['node'], skipLibCheck: false },
    files: ['types.ts', 'addon/.bedrock-core/generated/guides/logic/guides.generated.d.ts'],
  }));
  yarn(['tsc', '--noEmit'], root);
  const cli = spawnSync(process.execPath, ['node_modules/@bedrock-core/builder/dist/bin/builder.js', '--help'], { cwd: root, encoding: 'utf8' });

  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /core-builder/);
  yarn(['exec', 'core-builder', '--help'], root);

  for (const pkg of packages.filter(pkg => pkg.name !== '@bedrock-core/builder')) {
    const standalone = await mkdtemp(path.join(tmpdir(), 'builder-standalone-check-'));

    try {
      await writeFile(path.join(standalone, 'package.json'), JSON.stringify({
        name: 'builder-standalone-check', private: true, type: 'module', packageManager: 'yarn@4.16.0',
        dependencies: { [pkg.name]: files[pkg.name] }, resolutions: files,
      }));
      await writeFile(path.join(standalone, '.yarnrc.yml'), 'nodeLinker: node-modules\nenableGlobalCache: true\n');
      yarn(['install'], standalone);

      if (pkg.name === '@bedrock-core/cli') {
        await writeFile(path.join(standalone, 'offline-network.mjs'), `
          import https from 'node:https';
          import { EventEmitter } from 'node:events';
          https.get = () => {
            const request = new EventEmitter();
            request.setTimeout = () => request;
            queueMicrotask(() => request.emit('error', new Error('Offline package verification')));
            return request;
          };
        `);
        const cli = path.join(standalone, 'node_modules/@bedrock-core/cli/dist/index.js');
        const generated = spawnSync(process.execPath, ['--import', './offline-network.mjs', cli, 'packed-addon', '--author', 'Reviewer', '--description', 'Packed builder scaffold', '--package-manager', 'none'], { cwd: standalone, encoding: 'utf8' });

        assert.equal(generated.status, 0, generated.stderr);
        const config = JSON.parse(await readFile(path.join(standalone, 'packed-addon/config.json'), 'utf8'));

        validateConfig(config);
        assert.equal(config.namespace, 'reviewer_packed_addon');
        const registration = await readFile(path.join(standalone, 'packed-addon/packs/BP/scripts/main.ts'), 'utf8');

        assert.match(registration, /creator: 'reviewer'/);
        assert.match(registration, /pack: 'packed_addon'/);
        await readFile(path.join(standalone, 'packed-addon/packs/BP/guides/en_US/intro.mdx'), 'utf8');
        await assert.rejects(readFile(path.join(standalone, 'packed-addon/guides/en_US/intro.mdx')), { code: 'ENOENT' });
        assert.ok(config.bedrockCore.profiles['build-test']);
        const version = spawnSync(process.execPath, [cli, '--version'], { cwd: standalone, encoding: 'utf8' });

        assert.equal(version.status, 0);
        assert.equal(version.stdout.trim(), pkg.version);

        const addon = path.join(standalone, 'packed-addon');
        const builder = path.join(root, 'node_modules/@bedrock-core/builder/dist/bin/builder.js');

        for (const profile of ['build', 'default', 'test', 'build-test']) {
          const planned = spawnSync(process.execPath, [builder, 'plan', 'config.json', profile], { cwd: addon, encoding: 'utf8' });

          assert.equal(planned.status, 0, planned.stdout + planned.stderr);
          const plan = JSON.parse(planned.stdout) as { stage: string; settings?: { manifestPath?: string } }[];

          assert.ok(plan.some(step => step.stage === 'ui-compiler'));
          assert.equal(plan.find(step => step.stage === 'manifest')?.settings?.manifestPath,
            profile === 'test' || profile === 'build-test' ? './packs/BP/manifest.test.json' : undefined);
        }

        continue;
      }

      const plugin = !['@bedrock-core/builder-plugin', '@bedrock-core/builder-validation'].includes(pkg.name);

      await writeFile(path.join(standalone, 'verify.mjs'), `await import(${JSON.stringify(pkg.name)});${plugin ? ` await import(${JSON.stringify(`${pkg.name}/plugin`)});` : ''}`);
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
