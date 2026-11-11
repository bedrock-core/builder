import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
const repository = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log('Usage: node scripts/benchmark-build.mjs [--fixture fixtures/acceptance] [--dependencies ../examples] [--samples 7] [--asset-files 1024] [--asset-bytes 32768] [--conditions description]');
  process.exit(0);
}

const allowed = ['--fixture', '--dependencies', '--samples', '--asset-files', '--asset-bytes', '--conditions'];

for (let index = 0; index < args.length; index += 2) {
  assert.ok(allowed.includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('--'), `Invalid option: ${args[index]}`);
}

const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const samples = Number(option('--samples', '7'));
const assetFiles = Number(option('--asset-files', '1024'));
const assetBytes = Number(option('--asset-bytes', '32768'));
const dependencies = path.resolve(repository, option('--dependencies', '../examples'));
const fixture = path.resolve(repository, option('--fixture', 'fixtures/acceptance'));
const ignored = new Set(['.git', 'node_modules', '.bedrock-core', 'dist']);

for (const [name, value] of Object.entries({ samples, assetFiles, assetBytes })) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
}

const output = await mkdtemp(path.join(await realpath(tmpdir()), 'builder-build-benchmark-'));
const receipt = path.join(repository, '.bedrock-core/build-benchmark', path.basename(output));

await mkdir(receipt, { recursive: true });

try {
  const tooling = path.join(output, 'tooling');
  const frozenFixture = path.join(output, 'fixture');
  const dependencyRoot = path.join(output, 'dependencies');
  const overrides = new Map();

  async function linkModules(source, destination) {
    await mkdir(destination, { recursive: true });

    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      if (entry.name.startsWith('@')) {
        await linkModules(path.join(source, entry.name), path.join(destination, entry.name));
      } else {
        const scope = path.basename(source).startsWith('@') ? path.basename(source) + '/' : '';
        const target = overrides.get(scope + entry.name) ?? await realpath(path.join(source, entry.name));

        await symlink(target, path.join(destination, entry.name), process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
  }

  await cp(path.join(repository, 'src'), path.join(tooling, 'src'), { recursive: true });
  await cp(path.join(repository, 'schemas'), path.join(tooling, 'schemas'), { recursive: true });
  await cp(path.join(repository, 'packages'), path.join(tooling, 'packages'), { recursive: true, filter: file => !ignored.has(path.basename(file)) });
  await cp(path.join(repository, 'package.json'), path.join(tooling, 'package.json'));
  overrides.set(JSON.parse(await readFile(path.join(tooling, 'package.json'), 'utf8')).name, tooling);
  await cp(fixture, frozenFixture, { recursive: true, filter: file => !ignored.has(path.basename(file)) });
  const metadata = JSON.parse(await readFile(path.join(frozenFixture, 'package.json'), 'utf8'));
  const queue = Object.keys(metadata.dependencies ?? {});

  for (const entry of await readdir(path.join(tooling, 'packages'))) {
    const root = path.join(tooling, 'packages', entry);
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

    overrides.set(metadata.name, root);
  }

  for (let index = 0; index < queue.length; index++) {
    const name = queue[index];

    if (overrides.has(name) || (!name.startsWith('@bedrock-core/') && !name.startsWith('@minecraft/'))) {
      continue;
    }

    let original;

    try {
      original = await realpath(path.join(dependencies, 'node_modules', name));
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    const root = path.join(dependencyRoot, 'packages', name);
    const metadata = JSON.parse(await readFile(path.join(original, 'package.json'), 'utf8'));
    const shipped = new Set(['package.json', 'src', 'index.d.ts', 'index.js', 'index.mjs', 'index.cjs']);

    const include = (value) => {
      if (typeof value === 'string' && !value.startsWith('../') && !path.isAbsolute(value)) {
        const first = value.replace(/^\.\//, '').split(/[/*]/)[0];

        if (first && first !== '.' && !ignored.has(first)) {
          shipped.add(first);
        }

        if (first === 'dist') {
          shipped.add(first);
        }
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(include);
      }
    };

    [metadata.exports, metadata.main, metadata.module, metadata.types, metadata.files].forEach(include);
    await mkdir(root, { recursive: true });

    for (const entry of shipped) {
      try {
        await lstat(path.join(original, entry));
      } catch (error) {
        if (error.code === 'ENOENT') {
          continue;
        }

        throw error;
      }

      await cp(path.join(original, entry), path.join(root, entry), { recursive: true, filter: file => !['node_modules', '.git', '.bedrock-core', 'build', 'graphify-out'].includes(path.basename(file)) });
    }

    overrides.set(name, root);
    queue.push(...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.peerDependencies ?? {}));
  }

  await linkModules(path.join(repository, 'node_modules'), path.join(tooling, 'node_modules'));
  await linkModules(path.join(dependencies, 'node_modules'), path.join(dependencyRoot, 'node_modules'));
  await writeFile(path.join(tooling, 'bench.mjs'), `
import { performance } from 'node:perf_hooks';
export const __bench = {
  records: {},
  begin(label) {
    const entry = this.records[label] ??= { ms: 0, calls: 0, bytes: 0 };
    const start = performance.now();
    return () => {
      entry.ms += performance.now() - start;
      entry.calls++;
    };
  },
  async measure(label, operation) {
    const end = this.begin(label);
    try {
      const value = await operation();
      if (label === 'publish-compare-read') {
        this.records[label].bytes += typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
      }
      return value;
    } finally { end(); }
  },
};
`);

  function instrument(file, text) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const f = ts.factory;
    const calls = {};
    const member = (object, property) => f.createPropertyAccessExpression(f.createIdentifier(object), property);

    const measure = (label, call) => {
      calls[label] = (calls[label] ?? 0) + 1;

      return f.createCallExpression(member('__bench', 'measure'), undefined, [
        f.createStringLiteral(label), f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), call),
      ]);
    };

    const enclosing = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isFunctionDeclaration(parent)) {
          return parent.name?.text;
        }
      }
    };

    const transformed = ts.transform(source, [(context) => {
      const visit = (node) => {
        const original = node;

        node = ts.visitEachChild(node, visit, context);

        if (ts.isAwaitExpression(original) && ts.isCallExpression(original.expression)) {
          const call = original.expression;
          const name = call.expression.getText(source);
          const argument = call.arguments[0]?.getText(source);
          let label;

          if (file === 'run.ts') {
            if (name === 'stagingInputs') {
              label = 'source-discovery';
            } else if (name === 'cp' && argument === 'project') {
              label = 'staging-copy';
            } else if (name === 'createFileCache') {
              label = 'cache-load';
            } else if (name === 'cache.save') {
              label = 'cache-save';
            } else if (name === 'rm' && argument === 'workspace') {
              label = 'workspace-cleanup';
            }
          } else if (enclosing(original) === 'publishPacks') {
            if (name === 'validatePackManifests') {
              label = 'publish-validation';
            } else if (name === 'inspectSource') {
              label = 'publish-inspection';
            } else if (name === 'sameTree') {
              label = 'publish-unchanged-check';
            } else if (name === 'cp') {
              label = argument === 'source' ? 'publish-next-snapshot' : 'publish-previous-snapshot';
            } else if (name === 'synchronize') {
              label = 'publish-apply';
            } else if (name === 'rm' && argument === 'workspace') {
              label = 'publish-cleanup';
            }
          } else if (['sameTree', 'synchronize'].includes(enclosing(original)) && name === 'Promise.allSettled') {
            label = 'publish-compare-batch';
          }

          if (label) {
            return f.updateAwaitExpression(node, measure(label, node.expression));
          }
        }

        if (file === 'run.ts' && ts.isForOfStatement(original) && original.expression.getText(source) === 'plan.entries()') {
          calls.stages = (calls.stages ?? 0) + 1;
          const label = f.createBinaryExpression(f.createStringLiteral('stage:'), ts.SyntaxKind.PlusToken, f.createConditionalExpression(f.createBinaryExpression(member('step', 'kind'), ts.SyntaxKind.EqualsEqualsEqualsToken, f.createStringLiteral('plugin')), undefined, member('step', 'plugin'), undefined, member('step', 'stage')));
          const start = f.createVariableStatement(undefined, f.createVariableDeclarationList([
            f.createVariableDeclaration('__finishStage', undefined, undefined, f.createCallExpression(member('__bench', 'begin'), undefined, [label])),
          ], ts.NodeFlags.Const));
          const body = f.createBlock([start, f.createTryStatement(node.statement, undefined, f.createBlock([f.createExpressionStatement(f.createCallExpression(f.createIdentifier('__finishStage'), undefined, []))]))], true);

          return f.updateForOfStatement(node, node.awaitModifier, node.initializer, node.expression, body);
        }

        return node;
      };

      return root => ts.visitNode(root, visit);
    }]);
    const printed = ts.createPrinter().printFile(transformed.transformed[0]);

    transformed.dispose();
    assert.ok(file === 'run.ts' ? calls.stages === 1 && calls['staging-copy'] === 1 : calls['publish-next-snapshot'] === 1 && calls['publish-previous-snapshot'] === 1);

    return { text: `import { __bench } from '../bench.mjs';\n${printed}`, calls };
  }

  const instrumentation = {};

  for (const file of ['run.ts', 'export.ts']) {
    const result = instrument(file, await readFile(path.join(tooling, 'src', file), 'utf8'));

    await writeFile(path.join(tooling, 'src', file), result.text);
    await writeFile(path.join(receipt, file), result.text);
    instrumentation[file] = result.calls;
  }

  const { runBuild } = await import(pathToFileURL(path.join(tooling, 'src/run.ts')).href);
  const { configSchema } = await import(pathToFileURL(path.join(tooling, 'src/config.ts')).href);
  const { __bench } = await import(pathToFileURL(path.join(tooling, 'bench.mjs')).href);
  const { stagingInputs, isStagingInput, stagingExclusions, isStagingExcluded } = await import(pathToFileURL(path.join(tooling, 'src/staging.ts')).href);

  async function inventory(root, selected = () => true) {
    const entries = {};

    async function walk(file) {
      if (!selected(file) || ignored.has(path.basename(file))) {
        return;
      }

      const info = await lstat(file);

      assert.equal(info.isSymbolicLink(), false, `Inventory cannot follow a symlink: ${file}`);

      if (info.isDirectory()) {
        for (const entry of await readdir(file)) {
          await walk(path.join(file, entry));
        }
      } else {
        const content = await readFile(file);

        entries[path.relative(root, file).replaceAll('\\', '/')] = { bytes: info.size, hash: createHash('sha256').update(content).digest('hex') };
      }
    }

    await walk(root);

    return { files: Object.keys(entries).length, bytes: Object.values(entries).reduce((sum, entry) => sum + entry.bytes, 0), entries };
  }

  const summarize = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, min: sorted[0], max: sorted.at(-1) };
  };

  const implementation = await inventory(path.join(tooling, 'src'));
  const plugins = await inventory(path.join(tooling, 'packages'));
  const fixtureBefore = await inventory(frozenFixture);

  async function dependencySources() {
    const metadata = JSON.parse(await readFile(path.join(frozenFixture, 'package.json'), 'utf8'));
    const queue = Object.keys(metadata.dependencies ?? {});
    const sources = {};

    for (let index = 0; index < queue.length; index++) {
      const name = queue[index];

      if (Object.hasOwn(sources, name) || (!name.startsWith('@bedrock-core/') && !name.startsWith('@minecraft/'))) {
        continue;
      }

      let root;

      try {
        root = await realpath(path.join(dependencyRoot, 'node_modules', name));
      } catch (error) {
        if (error.code === 'ENOENT') {
          continue;
        }

        throw error;
      }

      const content = await readFile(path.join(root, 'package.json'), 'utf8');
      const packageMetadata = JSON.parse(content);
      let code;

      try {
        code = await inventory(path.join(root, 'src'));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }

      sources[name] = { version: packageMetadata.version, metadata: createHash('sha256').update(content).digest('hex'), code };
      queue.push(...Object.keys(packageMetadata.dependencies ?? {}), ...Object.keys(packageMetadata.peerDependencies ?? {}));
    }

    return sources;
  }

  const installedSources = await dependencySources();

  await cp(tooling, path.join(receipt, 'snapshot/builder'), { recursive: true, filter: file => path.basename(file) !== 'node_modules' });
  await cp(path.join(dependencyRoot, 'packages'), path.join(receipt, 'snapshot/dependencies'), { recursive: true });
  await cp(frozenFixture, path.join(receipt, 'snapshot/fixture'), { recursive: true });
  const report = {
    environment: { node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    contract: 'Sequential in-process builds against frozen Builder, plugin and local dependency sources. Cold clears Builder compiler caches and retains prior exports; warm retains caches and records any misses. OS caches are not flushed. Bootstrap, fixture setup and verification are outside timers. Stage and nested publication timers overlap and must not be added together.',
    samples, fixture, dependencies, conditions: option('--conditions', 'not recorded'), implementation, plugins, installedSources, fixtureSources: fixtureBefore, instrumentation, workloads: [],
  };

  for (const scaled of [false, true]) {
    const project = path.join(output, scaled ? 'asset-heavy' : 'acceptance');

    await cp(frozenFixture, project, { recursive: true });
    await symlink(path.join(dependencyRoot, 'node_modules'), path.join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const configPath = path.join(project, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const settings = config.bedrockCore.profiles.default;

    settings.export = Object.fromEntries(Object.keys(config.packs).map(id => [id, `./output/${id}`]));
    const paths = Object.values(settings.export).map(file => path.resolve(project, file));

    if (scaled) {
      const pack = config.packs.assets;

      assert.equal(typeof pack, 'string', 'The scaled fixture needs the assets pack');
      const assets = path.join(project, pack, 'benchmark-assets');

      await mkdir(assets, { recursive: true });

      for (let index = 0; index < assetFiles; index++) {
        await writeFile(path.join(assets, `${index}.bin`), Buffer.alloc(assetBytes, 0xa7));
      }
    }

    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const inputs = await stagingInputs(project, config, 'default', configPath, paths);
    const exclusions = stagingExclusions(project, config, configPath);
    const sourceInventory = await inventory(project, file => isStagingInput(file, inputs) && !isStagingExcluded(file, exclusions));
    const workload = { name: scaled ? 'acceptance + synthetic assets' : 'acceptance', validation: settings.validation ?? configSchema.definitions.profile.properties.validation.default, synthetic: scaled ? { files: assetFiles, bytesPerFile: assetBytes } : null, sources: sourceInventory, warmups: [], runs: [], summary: {} };
    const options = { configPath, logger: { info() { }, warn: console.warn, error: console.error } };

    report.workloads.push(workload);

    for (let index = 0; index < 2; index++) {
      const start = performance.now();

      await runBuild(options);
      workload.warmups.push(performance.now() - start);
    }

    const previous = {};

    for (const [id, destination] of Object.entries(settings.export)) {
      previous[id] = await inventory(path.resolve(project, destination));
    }

    workload.outputs = previous;

    for (let cycle = 0; cycle < samples; cycle++) {
      for (const mode of cycle % 2 ? ['warm', 'cold'] : ['cold', 'warm']) {
        if (mode === 'cold') {
          const cache = path.join(project, '.bedrock-core/cache');

          assert.ok(cache.startsWith(output + path.sep));
          await rm(cache, { recursive: true, force: true });
        }

        __bench.records = {};
        const start = performance.now();
        const result = await runBuild(options);
        const ms = performance.now() - start;
        const compilations = { executed: result.compilations.filter(entry => entry.status === 'executed').length, cached: result.compilations.filter(entry => entry.status === 'cached').length };

        assert.ok(result.compilations.length > 0);
        assert.ok(mode !== 'cold' || compilations.executed > 0, 'Cold cache contract failed');

        for (const [id, destination] of Object.entries(settings.export)) {
          assert.deepEqual(await inventory(path.resolve(project, destination)), previous[id], `Output changed in ${mode} ${cycle}: ${id}`);
        }

        const cacheMisses = mode === 'warm' ? result.compilations.filter(entry => entry.status === 'executed').map(entry => entry.id) : [];

        workload.runs.push({ cycle, mode, ms, compilations, cacheMisses, phases: structuredClone(__bench.records) });
        await writeFile(path.join(receipt, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
        console.log(JSON.stringify({ workload: workload.name, cycle, mode, ms: Math.round(ms), compilations }));
      }
    }

    for (const mode of ['cold', 'warm']) {
      const runs = workload.runs.filter(run => run.mode === mode);
      const phases = [...new Set(runs.flatMap(run => Object.keys(run.phases)))];

      workload.summary[mode] = { totalMs: summarize(runs.map(run => run.ms)), phases: Object.fromEntries(phases.map(label => [label, summarize(runs.map(run => run.phases[label]?.ms ?? 0))])) };
    }

    await writeFile(path.join(receipt, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }

  assert.deepEqual(await inventory(path.join(tooling, 'src')), implementation, 'Builder snapshot changed during measurement');
  assert.deepEqual(await inventory(path.join(tooling, 'packages')), plugins, 'Builder plugin snapshot changed during measurement');
  assert.deepEqual(await dependencySources(), installedSources, 'Installed dependency sources changed during measurement');
  assert.deepEqual(await inventory(frozenFixture), fixtureBefore, 'Fixture snapshot changed during measurement');
  report.verified = true;
  await writeFile(path.join(receipt, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: path.join(receipt, 'report.json'), verified: true }));
} finally {
  assert.ok(path.dirname(output) === await realpath(tmpdir()) && path.basename(output).startsWith('builder-build-benchmark-'));
  await rm(output, { recursive: true, force: true });
}
