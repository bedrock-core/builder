import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { fixture, compileFixture, evaluate, fakeEngine, runtimeAliases, runtimeSources } from '../fixtures/native-access/harness.ts';
import { instrument } from '../fixtures/native-access/transform.ts';
import { API, ModuleKind, ModuleResolutionKind } from 'typescript-native/sync';
import { runBuild } from '../src/run.ts';
import { acceptanceDependencies, linkAcceptanceDependencies } from '../test-support/acceptance.ts';
const repository = path.resolve(fixture, '../..');

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);

  if (index < 0) {
    return fallback;
  }

  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }

  return process.argv[index + 1];
};

const input = path.resolve(option('--fixture', fixture));
const suite = option('--suite', 'lookups');
const native = process.argv.includes('--native');
const runner = process.env.BUILDER_BDS_RUNNER;
const buildOnly = process.argv.includes('--build-only');
const qualifying = suite === 'qualification';

assert.ok(['lookups', 'lifetime', 'qualification'].includes(suite), '--suite must be lookups, lifetime or qualification');
assert.ok(!native || !qualifying, 'Use native-access-qualification.mjs with an existing server directory for qualification');
assert.ok(!native || runner, 'Native access acceptance needs BUILDER_BDS_RUNNER pointing to the installed bc-bds.mjs CLI');
const defaultOutput = path.join(repository, '.bedrock-core/native-access');
const receipt = path.resolve(option('--output', suite === 'lifetime' ? path.join(defaultOutput, 'lifetime') : defaultOutput));
const serverHome = path.resolve(process.env.BC_BDS_HOME || path.join(repository, '.bds'));
const instrumentSource = input === path.resolve(fixture) ? instrument : (await import(pathToFileURL(path.join(input, 'transform.ts')).href)).instrument;
const productionCompiler = process.env.BUILDER_NATIVE_ACCESS_COMPILER === 'native';
const nativeInstrument = productionCompiler
  ? (await import(pathToFileURL(input === path.resolve(fixture) ? path.join(repository, 'packages/bundler/src/native-access-transform.ts') : path.join(input, 'transform.native.ts')).href)).instrument
  : undefined;
const runtimeSource = input === path.resolve(fixture) ? runtimeAliases['@bedrock-core/server-runtime/api/native-access'] : path.join(input, 'runtime.ts');
const root = await mkdtemp(path.join(tmpdir(), 'native-access-'));

const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);

  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1), samples: values };
};

const put = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const report = { scope: suite === 'lifetime' ? 'native reference identity and lifetime contracts' : 'entity inventory lookup provenance prototype', inputs: {}, operations: {}, recipe: null, recipeBytes: 0, offline: null, build: null, native: null, lifetime: null };

try {
  await mkdir(receipt, { recursive: true });

  for (const name of ['authored.ts', 'baseline.ts', 'library.ts', 'runtime.ts', 'transform.ts', ...(qualifying ? ['provider-api.ts', 'consumer.ts', 'qualification-api.ts', 'qualification.ts'] : [])]) {
    report.inputs[name] = createHash('sha256').update(await readFile(path.join(input, name))).digest('hex');
  }

  for (const name of ['dependency/package.json', 'javascript-dependency/package.json', 'javascript-dependency/index.d.ts', 'javascript-dependency/commonjs.d.cts']) {
    try {
      report.inputs[name] = createHash('sha256').update(await readFile(path.join(input, name))).digest('hex');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const compiled = await compileFixture(input, instrumentSource);

  for (const file of compiled.instrumented.keys()) {
    report.inputs[path.relative(input, file).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(file)).digest('hex');
  }

  report.operations = Object.fromEntries([...compiled.instrumented.entries()].map(([file, output]) => [path.basename(file), output.operations]));
  report.inputs.productionRuntime = createHash('sha256').update(await readFile(runtimeSource)).digest('hex');

  if (nativeInstrument) {
    report.inputs.productionTransform = createHash('sha256').update(await readFile(input === path.resolve(fixture) ? path.join(repository, 'packages/bundler/src/native-access-transform.ts') : path.join(input, 'transform.native.ts'))).digest('hex');
  }

  await put(path.join(receipt, 'authored.instrumented.ts'), compiled.instrumented.get(path.join(input, 'authored.ts')).code);
  const engine = fakeEngine();
  const realm = engine.realm();
  const tracked = evaluate(compiled.code, realm.minecraft);
  const direct = evaluate(compiled.baseline, realm.minecraft);
  const entity = tracked.create({ x: 0, y: 0, z: 0 });

  report.recipe = tracked.access.encode(tracked.slot(entity, 3));
  report.recipeBytes = Buffer.byteLength(JSON.stringify(report.recipe));
  const loops = 20000;
  const baselineSamples = [];
  const trackedSamples = [];

  for (let index = 0; index < 2000; index++) {
    direct.slot(entity, index % 9);
    tracked.slot(entity, index % 9);
  }

  for (let round = 0; round < 7; round++) {
    for (const enabled of round % 2 ? [true, false] : [false, true]) {
      const run = enabled ? tracked.slot : direct.slot;
      const start = performance.now();

      for (let index = 0; index < loops; index++) {
        run(entity, index % 9);
      }

      (enabled ? trackedSamples : baselineSamples).push(performance.now() - start);
    }
  }

  report.offline = { loops, baseline: summary(baselineSamples), tracked: summary(trackedSamples), environment: 'Node fake native engine; not a BDS performance result' };

  if (native || buildOnly) {
    const dependencies = acceptanceDependencies(repository, 'acceptance', ['@minecraft/server', '@bedrock-core/server-runtime']);

    await linkAcceptanceDependencies(root, dependencies);
    await mkdir(path.join(root, 'node_modules/@prototype'), { recursive: true });
    const link = (from, to) => symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir');

    const provider = path.join(root, 'provider/packs/BP');
    const consumer = path.join(root, 'consumer/packs/BP');

    for (const [role, directory] of [['provider', provider], ['consumer', consumer]]) {
      const config = JSON.parse(await readFile(path.join(repository, `fixtures/api/${role}/config.json`), 'utf8'));

      config.name = `native-access-${role}`;
      await put(path.join(root, role, 'config.json'), config);
      await put(path.join(root, role, 'package.json'), {
        name: `@prototype/native-access-${role}`, version: '1.0.0', private: true, type: 'module',
        ...(role === 'provider' ? { exports: { '.': './packs/BP/scripts/api.ts', './manifest.json': './packs/BP/manifest.json' } } : {}),
      });
      const manifest = JSON.parse(await readFile(path.join(repository, `fixtures/api/${role}/packs/BP/manifest.json`), 'utf8'));

      manifest.namespace = `native_access_${role}`;
      manifest.header.name = `Native access ${role}`;
      manifest.header.uuid = role === 'provider' ? 'bc15e2fd-d80b-46e5-8f3f-303000d03fce' : 'be41d66b-35f6-47de-a779-8933ba63e33d';

      for (const [index, module] of manifest.modules.entries()) {
        module.uuid = role === 'provider' ? '396abc33-083a-4675-9fba-a24c8956cb5c' : index === 0 ? 'b3aef9a6-2409-49ef-8ab9-1f369d31119c' : '21b70aa8-9e41-4246-aac2-381e063639d3';
      }

      manifest.dependencies = manifest.dependencies.filter(item => item.module_name.startsWith('@minecraft/'));

      if (role === 'consumer') {
        manifest.dependencies.push({ module_name: '@prototype/native-access-provider' });
      }

      delete manifest.optionalDependencies;
      await put(path.join(directory, 'manifest.json'), manifest);
      await mkdir(path.join(directory, 'scripts'), { recursive: true });

      if (role === 'consumer') {
        await put(path.join(directory, 'scripts/runtime.ts'), 'export { nativeAccess } from \'@bedrock-core/server-runtime/api/native-access\';\n');
      }
    }

    await link(path.join(root, 'provider'), path.join(root, 'node_modules/@prototype/native-access-provider'));
    const sharedRuntime = path.join(root, 'node_modules/@prototype/native-access-runtime');

    await put(path.join(sharedRuntime, 'package.json'), { name: '@prototype/native-access-runtime', version: '1.0.0', type: 'module', exports: './runtime.ts' });
    const productionRuntime = runtimeAliases['@bedrock-core/server-runtime/api/native-access'];

    assert.equal(createHash('sha256').update(await readFile(productionRuntime)).digest('hex'), report.inputs.productionRuntime, 'Qualification runtime snapshot must match the installed production tracker');
    await put(path.join(sharedRuntime, 'runtime.ts'), 'export { nativeAccess } from \'@bedrock-core/server-runtime/api/native-access\';\n');

    for (const [directory, name] of [['dependency', 'native-access-helper'], ['javascript-dependency', 'native-access-js']]) {
      try {
        await access(path.join(input, directory, 'package.json'));
        await cp(path.join(input, directory), path.join(root, 'node_modules/@prototype', name), { recursive: true });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    if (qualifying) {
      const controls = path.join(root, 'node_modules/@prototype/native-access-js-control');

      await cp(path.join(input, 'javascript-dependency'), controls, { recursive: true });
      const metadata = JSON.parse(await readFile(path.join(controls, 'package.json'), 'utf8'));

      metadata.name = '@prototype/native-access-js-control';
      await put(path.join(controls, 'package.json'), metadata);
      await put(path.join(provider, 'scripts/provider-api.ts'), (await readFile(path.join(input, 'provider-api.ts'), 'utf8')).replace('from \'./runtime\'', 'from \'@prototype/native-access-runtime\''));
      await copyFile(path.join(input, 'consumer.ts'), path.join(consumer, 'scripts/consumer.ts'));
    }

    for (const name of ['authored.ts', 'library.ts', 'baseline.ts']) {
      await copyFile(path.join(input, name), path.join(provider, 'scripts', name));
    }

    const providerCode = (await readFile(path.join(input, qualifying ? 'qualification-api.ts' : 'provider-api.ts'), 'utf8')).replace('from \'./runtime\'', 'from \'@prototype/native-access-runtime\'');

    await put(path.join(provider, 'scripts/api.ts'), providerCode);
    await put(path.join(provider, 'scripts/main.ts'), 'import {core} from \'@bedrock-core/server-runtime\'; import manifest from \'../manifest.json\'; core.register({manifest});\n');
    await copyFile(path.join(input, qualifying ? 'qualification.ts' : suite === 'lifetime' ? 'lifetime.ts' : 'consumer.ts'), path.join(consumer, 'scripts/main.ts'));
    const options = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, noEmit: true, allowJs: true, resolveJsonModule: true, allowImportingTsExtensions: true, types: [] };
    const sources = [path.join(provider, 'scripts/api.ts'), path.join(consumer, 'scripts/main.ts')];
    const format = diagnostics => ts.formatDiagnostics(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n' });
    let program = ts.createProgram(sources, options);

    assert.equal(ts.getPreEmitDiagnostics(program).length, 0, format(ts.getPreEmitDiagnostics(program)));

    const authored = path.join(provider, 'scripts/authored.ts');
    const runtime = await runtimeSources([authored], { absWorkingDir: root });
    const captureProgram = ts.createProgram([authored, ...[...runtime.keys()].filter(file => /\.[cm]?js$/.test(file))], options);

    using nativeApi = new API();
    const { baseUrl, ...nativeOptions } = options;
    const nativeProgram = productionCompiler
      ? nativeApi.createProgram([authored, ...runtime.keys()], {
          ...nativeOptions, pathsBasePath: baseUrl ?? root, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
        })
      : undefined;

    for (const source of captureProgram.getSourceFiles().filter(file => !file.isDeclarationFile)) {
      const file = source.fileName;
      const relative = path.relative(root, file);

      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || file === path.join(sharedRuntime, 'runtime.ts')) {
        continue;
      }

      const output = nativeInstrument
        ? nativeInstrument(nativeProgram, nativeProgram.getSourceFile(file), '@prototype/native-access-runtime', nativeApi.printer, runtime.get(path.resolve(file)))
        : instrumentSource(captureProgram, source, '@prototype/native-access-runtime', runtime.get(path.resolve(file)));

      await writeFile(file, output.code);
    }

    program = ts.createProgram(sources, options);
    assert.equal(ts.getPreEmitDiagnostics(program).length, 0, format(ts.getPreEmitDiagnostics(program)));
    await mkdir(path.join(consumer, 'structures/native_access'), { recursive: true });
    await copyFile(path.join(repository, 'fixtures/acceptance/packs/BP/structures/builder_acceptance/empty.mcstructure'), path.join(consumer, 'structures/native_access/empty.mcstructure'));

    for (const role of ['provider', 'consumer']) {
      const buildOptions = { configPath: path.join(root, role, 'config.json'), profile: 'build' };

      await runBuild(buildOptions);
      const warm = await runBuild(buildOptions);

      assert.ok(warm.compilations.every(item => item.status === 'cached'));
    }

    const bundled = await readFile(path.join(root, 'dist/consumer/scripts/main.js'), 'utf8');
    const providerBundle = await readFile(path.join(root, 'dist/provider/scripts/main.js'), 'utf8');

    assert.doesNotMatch(bundled, /native-access-owner-code-ran-in-consumer/);
    assert.equal(providerBundle.match(/native object has no captured lookup path/g)?.length, 1, 'Provider and dependency lookups must share one tracker');
    report.build = { profile: 'build', providerBytes: Buffer.byteLength(providerBundle), consumerBytes: Buffer.byteLength(bundled), installedJavaScript: [...runtime.keys()].filter(file => /native-access-js[\\/].*\.[cm]?js$/.test(file)).map(file => path.relative(root, file).replaceAll('\\', '/')) };

    if (process.argv.includes('--retain-packs')) {
      const packs = path.join(receipt, 'packs');

      await cp(path.join(root, 'dist'), packs, { recursive: true, force: false, errorOnExist: true });
      report.build.packs = packs;
    }

    if (native) {
      let output = '';
      const status = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner, 'run', '--packs', path.join(root, 'dist'), '--tag', suite === 'lifetime' ? 'native_lifetime' : 'native_access', '--expect-registered', suite === 'lifetime' ? '1' : '2', '--idle', '25', '--timeout', '180', '--offline', '--json', path.join(receipt, 'result.json')], {
          cwd: repository, env: { ...process.env, BC_BDS_HOME: serverHome }, stdio: ['ignore', 'pipe', 'pipe'],
        });

        for (const stream of [child.stdout, child.stderr]) {
          stream.on('data', (chunk) => {
            const text = String(chunk);

            output += text;
            process.stdout.write(text);
          });
        }

        child.once('error', reject);
        child.once('exit', resolve);
      });

      await writeFile(path.join(receipt, 'native.log'), output);
      const match = output.match(/NATIVE_ACCESS_BENCH (\{[^\r\n]+\})/);

      if (match) {
        const samples = JSON.parse(match[1]);

        const baseline = summary(samples.direct);
        const tracked = summary(samples.tracked);

        report.native = {
          engineVersion: output.match(/Version:\s+([0-9A-Za-z.-]+)/)?.[1] ?? 'unreported',
          loops: samples.loops, baseline, tracked,
          ratio: baseline.median ? tracked.median / baseline.median : null,
          addedMicrosecondsPerChain: (tracked.median - baseline.median) * 1000 / samples.loops,
        };
      }

      const lifetime = output.match(/NATIVE_ACCESS_LIFETIME (\{[^\r\n]+\})/);

      if (lifetime) {
        report.lifetime = { engineVersion: output.match(/Version:\s+([0-9A-Za-z.-]+)/)?.[1] ?? 'unreported', ...JSON.parse(lifetime[1]) };
      }

      await put(path.join(receipt, 'report.json'), report);
      assert.equal(status, 0, 'Native access prototype GameTests must pass');
      assert.ok(suite === 'lifetime' ? report.lifetime : report.native, 'Selected native evidence must be recorded');
    }
  }

  await put(path.join(receipt, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('native-access-'));
  await rm(root, { recursive: true, force: true });
}
