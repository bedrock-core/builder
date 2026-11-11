import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ScriptTarget } from 'typescript-native/ast';
import { API, formatDiagnostics, ModuleKind, ModuleResolutionKind } from 'typescript-native/sync';
import { programDiagnostics } from '../packages/bundler/src/typescript.ts';
import { createHash } from 'node:crypto';
import { runBuild } from '../src/run.ts';
import { scriptOutputManifest } from '@bedrock-core/builder-manifest';
import { acceptanceDependencies, installedPackage, linkAcceptanceDependencies } from '../test-support/acceptance.ts';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'api-package-'));
const author = path.join(root, 'author');
const consumer = path.join(root, 'consumer');
const receipt = path.join(repository, '.bedrock-core/api-package');
const report = { scope: 'automatic provider API publication and ordinary consumer bundling', status: 'running', sources: {}, packages: [] };
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = [
  'scripts/api-package-acceptance.mjs', 'test-support/acceptance.ts',
  'packages/bundler/src/api.ts', 'packages/bundler/src/api-source.ts', 'packages/bundler/src/api-package.ts',
  'packages/bundler/src/api-provider.ts', 'packages/bundler/src/plugin.ts', 'packages/bundler/src/entries.ts',
  'packages/bundler/src/index.ts', 'packages/bundler/src/native-access.ts', 'packages/bundler/src/native-access-transform.ts',
  'packages/bundler/src/typescript.ts', 'packages/manifest/src/api-package.ts', 'packages/manifest/src/authoring.ts',
  'fixtures/api/provider/packs/BP/manifest.json', 'fixtures/api/consumer/packs/BP/manifest.json', 'fixtures/api/optional/manifest.json',
  'fixtures/api/provider/packs/BP/api/native.ts', 'fixtures/api/provider/packs/BP/api/inventory-helper.js',
  'fixtures/api/provider/packs/BP/api/inventory-helper.cjs', 'fixtures/api/consumer/packs/BP/scripts/native-contracts.ts',
  'fixtures/api/provider/packs/BP/api/index.ts', 'fixtures/api/provider/packs/BP/scripts/owner.ts',
  'fixtures/api/provider/packs/BP/scripts/state.ts', 'fixtures/api/consumer/packs/BP/scripts/main.ts',
  'fixtures/api-package/standalone.ts', 'fixtures/api-package/handover.ts', 'fixtures/api-package/types.ts',
];
const runtimeSourceFiles = [
  'src/api/native-access.ts', 'src/api/native-values.ts', 'src/api/references.ts',
  'src/api/codec.ts', 'src/api/types.ts', 'src/api/client.ts', 'src/api/declaration.ts',
  'src/api/index.ts', 'src/index.ts', 'src/runtime.ts', 'src/library.ts', 'src/installation.ts', 'package.json',
];

const put = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};

try {
  const source = path.join(repository, 'fixtures/api');
  const dependencies = acceptanceDependencies(repository, 'api');
  const installed = dependencies.modules;
  const runtime = installedPackage(dependencies, '@bedrock-core/server-runtime');
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));

  sourceFiles.push(...runtimeSourceFiles.map(file => path.relative(repository, path.join(runtime, file))));

  for (const file of sourceFiles) {
    report.sources[file] = hash(await readFile(path.resolve(repository, file)));
  }

  await cp(source, author, { recursive: true, filter: file => path.basename(file) !== 'node_modules' });
  await cp(path.join(source, 'consumer'), consumer, { recursive: true });

  const link = async (from, to) => {
    await mkdir(path.dirname(to), { recursive: true });
    await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir');
  };

  for (const target of [author, consumer]) {
    await linkAcceptanceDependencies(target, dependencies, { exclude: ['@bedrock-core/api-provider', '@bedrock-core/api-optional'] });
  }

  for (const role of ['provider', 'optional']) {
    await link(path.join(author, role), path.join(author, 'node_modules/@bedrock-core', `api-${role}`));

    if (role === 'optional') {
      const directory = path.join(author, role);
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));

      await put(path.join(directory, 'packs/BP/api.ts'), await readFile(path.join(directory, 'api.ts'), 'utf8'));
      await put(path.join(directory, 'packs/BP/manifest.json'), await readFile(path.join(directory, 'manifest.json'), 'utf8'));
      metadata.exports = { '.': './packs/BP/api.ts', './manifest.json': './packs/BP/manifest.json' };
      await put(path.join(directory, 'package.json'), metadata);
      await put(path.join(directory, 'packs/BP/scripts/main.ts'), 'import {core,registerModule} from \'@bedrock-core/server-runtime\'; import * as API from \'../api\'; import manifest from \'../manifest.json\'; core.register({manifest,providerApi:registerModule(API)});');
      await put(path.join(directory, 'config.json'), {
        targetVersion: '1.26.50', name: 'Optional API', authors: [], packs: { behaviorPack: './packs/BP' },
        bedrockCore: { formatVersion: '1.0.0', profiles: { build: { stages: { 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false }, export: { behaviorPack: '../optional-dist/BP' } } } },
      });
    }

    const built = await runBuild({ configPath: path.join(author, role, 'config.json'), profile: 'build' });
    const warm = await runBuild({ configPath: path.join(author, role, 'config.json'), profile: 'build' });

    assert.ok(warm.compilations.every(item => item.status === 'cached'), `${role}: API and runtime outputs must be reused`);
    assert.ok(built.apiOutput, `${role}: provider build must publish its API package`);
    const output = built.apiOutput;
    const packageMetadata = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
    const emitted = { name: packageMetadata.name, exports: Object.keys(packageMetadata.exports) };
    const providerCode = await readFile(path.join(built.outputPaths.behaviorPack, 'scripts/main.js'));

    emitted.runtime = { sha256: hash(providerCode), bytes: providerCode.length };
    const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

    await access(npm);
    await mkdir(path.join(root, 'archives'), { recursive: true });
    const packed = JSON.parse((await execute(process.execPath, [npm, 'pack', output, '--pack-destination', path.join(root, 'archives'), '--ignore-scripts', '--json'], {
      cwd: root, env: { ...process.env, npm_config_cache: path.join(root, 'npm-cache') },
    })).stdout)[0];
    const archive = path.join(root, 'archives', packed.filename);
    const target = path.join(consumer, 'node_modules', emitted.name);

    assert.ok(packed.files.every(item => !/\.(?:[cm]?tsx?|map)$/.test(item.path) || /\.d\.[cm]?ts$/.test(item.path)), 'Published API packages contain declarations and JS, without authored TS or source maps');
    await mkdir(target, { recursive: true });
    await execute('tar', ['-xf', archive, '--strip-components=1', '-C', target]);
    await mkdir(receipt, { recursive: true });
    await copyFile(archive, path.join(receipt, packed.filename));

    for (const item of packed.files) {
      const text = await readFile(path.join(target, item.path), 'utf8');

      assert.doesNotMatch(text, /provider-implementation-ran-in-consumer|account-implementation-ran-in-consumer/);

      if (item.path.endsWith('.js')) {
        assert.doesNotMatch(text, /function changeCurrency\(/);
      }

      assert.doesNotMatch(text, /(?:\.\.\/)+scripts\/owner|(?<!\.d)\.ts['"]/, 'Public declarations must not depend on provider implementation paths');
    }

    report.packages.push({ ...emitted, archive: packed.filename, sha256: hash(await readFile(archive)), bytes: packed.size, files: packed.files.map(item => item.path) });
  }

  const authoredManifest = JSON.parse(await readFile(path.join(consumer, 'packs/BP/manifest.json'), 'utf8'));
  const ownerManifest = JSON.parse(await readFile(path.join(author, 'provider/packs/BP/manifest.json'), 'utf8'));

  authoredManifest.dependencies = authoredManifest.dependencies.map(dependency => dependency.module_name === '@bedrock-core/api-provider'
    ? { uuid: ownerManifest.header.uuid, version: ownerManifest.header.version, namespace: ownerManifest.namespace }
    : dependency);
  delete authoredManifest.optionalDependencies;
  await put(path.join(consumer, 'packs/BP/manifest.json'), authoredManifest);
  await put(path.join(consumer, 'package.json'), {
    private: true, type: 'module', dependencies: {
      '@bedrock-core/api-provider': '1.0.0', '@bedrock-core/api-optional': '1.0.0',
      ...metadata.dependencies,
    },
  });
  const main = path.join(consumer, 'packs/BP/scripts/main.ts');
  const standalone = path.join(consumer, 'packs/BP/scripts/standalone.ts');
  const handover = path.join(consumer, 'packs/BP/scripts/handover.ts');
  const typeTests = path.join(consumer, 'types.ts');

  await copyFile(path.join(repository, 'fixtures/api-package/standalone.ts'), standalone);
  await copyFile(path.join(repository, 'fixtures/api-package/handover.ts'), handover);
  await copyFile(path.join(repository, 'fixtures/api-package/types.ts'), typeTests);
  using api = new API({ cwd: consumer });
  const program = api.createProgram([main, standalone, handover, typeTests], {
    target: ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: false, noEmit: true, resolveJsonModule: true, types: [],
    paths: { '@minecraft/common': [path.join(installed, '@minecraft/common/index.d.ts')] },
  });
  const diagnostics = programDiagnostics(program);

  assert.equal(diagnostics.length, 0, formatDiagnostics(diagnostics, api));
  const apiTypes = program.getSourceFileNames().filter(file => file.includes('/api-provider/'));

  assert.ok(apiTypes.length > 0 && apiTypes.every(file => program.getSourceFile(file)?.isDeclarationFile));

  const output = path.join(author, 'dist/consumer');
  const variants = [];

  for (const [mode, entry, tag, expected] of [['standalone', standalone, 'portable_api', 4], ['registered', main, 'api', 7], ['handover', handover, 'portable_handover', 1]]) {
    const bundled = await build({
      entryPoints: [entry], outfile: path.join(output, 'scripts/main.js'), write: false, bundle: true, format: 'esm', platform: 'neutral', target: 'es2020',
      external: ['@minecraft/*'], metafile: true, minify: true, sourcemap: false,
    });
    const inputs = Object.keys(bundled.metafile.inputs);
    const apiInputs = inputs.filter(file => file.replaceAll('\\', '/').includes('/api-provider/'));
    const bindings = inputs.filter(file => file.replaceAll('\\', '/').endsWith('/server-runtime/src/api/bindings.ts'));
    const nativeImports = Object.values(bundled.metafile.outputs).flatMap(item => item.imports).filter(item => item.external);

    assert.ok(apiInputs.length > 0 && apiInputs.every(file => !file.endsWith('.ts')));
    assert.equal(bindings.length, 1, 'Imported API packages share one set of runtime bindings');
    assert.ok(nativeImports.every(item => item.path.startsWith('@minecraft/')), 'No addon API or Core runtime import remains external');
    assert.ok(inputs.every(file => !path.resolve(file).replaceAll('\\', '/').startsWith(`${author.replaceAll('\\', '/')}/`)), 'The plain consumer cannot read provider source');

    if (mode === 'standalone') {
      assert.ok(inputs.every(file => !/server-runtime[\\/]src[\\/](?:runtime|host|translations)\.ts$/.test(file) && !/[\\/]db[\\/]src[\\/]/.test(file)), 'Standalone bindings exclude addon registration, host election, translations and persistence');
    }

    const code = bundled.outputFiles[0].text;

    assert.doesNotMatch(code, /provider-implementation-ran-in-consumer|account-implementation-ran-in-consumer/);
    variants.push({ mode, code, tag, expected, bytes: Buffer.byteLength(code), runtimeBindings: bindings.length, externals: [...new Set(nativeImports.map(item => item.path))] });
    await put(path.join(receipt, `${mode}.meta.json`), bundled.metafile);
    await put(path.join(receipt, `${mode}.js`), code);
  }

  const nativeManifest = scriptOutputManifest(structuredClone(authoredManifest));

  delete nativeManifest.namespace;
  nativeManifest.dependencies = nativeManifest.dependencies.map((dependency) => {
    delete dependency.namespace;

    return dependency;
  });
  await put(path.join(output, 'manifest.json'), nativeManifest);
  await mkdir(path.join(output, 'structures/api'), { recursive: true });
  await copyFile(path.join(repository, 'fixtures/acceptance/packs/BP/structures/builder_acceptance/empty.mcstructure'), path.join(output, 'structures/api/empty.mcstructure'));
  await mkdir(path.join(consumer, 'packs/BP/structures/api'), { recursive: true });
  await copyFile(path.join(output, 'structures/api/empty.mcstructure'), path.join(consumer, 'packs/BP/structures/api/empty.mcstructure'));
  const builderManifest = structuredClone(authoredManifest);

  builderManifest.dependencies = builderManifest.dependencies.map(dependency => dependency.uuid === ownerManifest.header.uuid ? { module_name: '@bedrock-core/api-provider' } : dependency);
  builderManifest.optionalDependencies = [{ module_name: '@bedrock-core/api-optional' }];
  await put(path.join(consumer, 'packs/BP/manifest.json'), builderManifest);
  const builderConfig = JSON.parse(await readFile(path.join(consumer, 'config.json'), 'utf8'));

  builderConfig.bedrockCore.profiles.build.export.behaviorPack = output;
  await put(path.join(consumer, 'config.json'), builderConfig);
  const builderResult = await runBuild({ configPath: path.join(consumer, 'config.json'), profile: 'build' });
  const builderWarm = await runBuild({ configPath: path.join(consumer, 'config.json'), profile: 'build' });

  assert.ok(builderWarm.compilations.every(item => item.status === 'cached'));
  assert.ok(builderResult.dependencies.every(file => !file.startsWith(path.join(author, 'provider'))));
  const builderCode = await readFile(path.join(output, 'scripts/main.js'), 'utf8');

  assert.doesNotMatch(builderCode, /provider-implementation-ran-in-consumer|account-implementation-ran-in-consumer/);
  variants.push({ mode: 'builder', code: builderCode, tag: 'api', expected: 7, bytes: Buffer.byteLength(builderCode), runtimeBindings: 1, externals: ['@minecraft/server', '@minecraft/server-gametest'] });
  report.consumer = { variants: variants.map(({ mode, code, bytes, runtimeBindings, externals }) => ({ mode, compiler: mode === 'builder' ? 'Builder consuming installed API clients' : 'plain esbuild; no plugins', sha256: hash(code), bytes, runtimeBindings, externals })) };
  const valueOnly = await build({
    stdin: { contents: 'export { Money } from \'@bedrock-core/api-provider/values\';', resolveDir: consumer, loader: 'js' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', metafile: true, minify: true,
  });

  assert.ok(Object.values(valueOnly.metafile.outputs).every(item => item.imports.length === 0), 'Shared value-only imports need no Minecraft module or external runtime');
  assert.ok(Object.keys(valueOnly.metafile.inputs).every(file => !file.replaceAll('\\', '/').endsWith('/api/client.ts')), 'Value-only imports do not initialize a transport client');
  report.consumer.valueOnlyBytes = valueOnly.outputFiles[0].contents.length;

  if (process.argv.includes('--native')) {
    const runner = process.env.BUILDER_BDS_RUNNER;
    const serverHome = path.resolve(process.env.BC_BDS_HOME ?? path.join(repository, '.bds'));

    assert.ok(runner, 'Native API acceptance needs BUILDER_BDS_RUNNER pointing to bc-bds.mjs');
    report.native = [];

    for (const variant of variants) {
      await put(path.join(output, 'scripts/main.js'), variant.code);
      let log = '';
      const status = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner, 'run', '--packs', path.join(author, 'dist'), '--tag', variant.tag, '--expect-registered', String(variant.expected), '--idle', '25', '--timeout', '180', '--offline', '--json', path.join(receipt, `${variant.mode}.result.json`)], {
          cwd: repository, env: { ...process.env, BC_BDS_HOME: serverHome }, stdio: ['ignore', 'pipe', 'pipe'],
        });

        for (const stream of [child.stdout, child.stderr]) {
          stream.on('data', (chunk) => {
            const text = String(chunk);

            log += text;
            process.stdout.write(text);
          });
        }

        child.once('error', reject);
        child.once('exit', resolve);
      });

      await put(path.join(receipt, `${variant.mode}.native.log`), log);
      report.native.push({ mode: variant.mode, engineVersion: log.match(/Version:\s+([0-9A-Za-z.-]+)/)?.[1] ?? 'unreported', status });
      assert.equal(status, 0, `${variant.mode}: portable API native acceptance must pass`);
    }
  }

  for (const file of sourceFiles) {
    assert.equal(hash(await readFile(path.resolve(repository, file))), report.sources[file], `Acceptance source changed: ${file}`);
  }

  report.status = 'passed';
  await put(path.join(receipt, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await put(path.join(receipt, 'report.json'), report);
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('api-package-'));
  await rm(root, { recursive: true, force: true });
}
