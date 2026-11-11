import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { emitApiLibrary } from '../packages/bundler/src/api-library.ts';
import { acceptanceDependencies, installedPackage, linkAcceptanceDependencies } from '../test-support/acceptance.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'navigation-api-'));
const receipt = path.join(repository, '.bedrock-core/navigation-api');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { scope: 'generated Navigation API over two independent script realms with plain esbuild', status: 'running', sources: {}, generated: {}, bundles: {} };

const put = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};

try {
  for (const file of ['scripts/navigation-api-acceptance.mjs', 'test-support/acceptance.ts', 'fixtures/navigation-api/package.json', 'packages/bundler/src/api-library.ts', 'packages/bundler/src/api.ts', 'packages/bundler/src/api-source.ts', 'fixtures/acceptance/packs/BP/structures/builder_acceptance/empty.mcstructure']) {
    report.sources[file] = hash(await readFile(path.join(repository, file)));
  }

  const dependencies = acceptanceDependencies(repository, 'navigation-api');
  const copiedPackages = new Map();

  await cp(path.join(repository, 'fixtures/navigation-api'), root, { recursive: true, filter: file => path.basename(file) !== 'node_modules' });
  await put(path.join(root, 'tsconfig.json'), { compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, jsx: 'react-jsx', jsxImportSource: '@bedrock-core/ui-runtime' } });

  await linkAcceptanceDependencies(root, dependencies, { exclude: ['@bedrock-core/navigation', '@bedrock-core/ui-runtime'] });

  // Copies model a normal hoisted installation and share one Core metadata registry.
  for (const name of ['navigation', 'ui-runtime']) {
    const source = installedPackage(dependencies, `@bedrock-core/${name}`);
    const target = path.join(root, 'node_modules/@bedrock-core', name);

    copiedPackages.set(name, source);
    await cp(path.join(source, 'src'), path.join(target, 'src'), { recursive: true });
    await cp(path.join(source, 'package.json'), path.join(target, 'package.json'));
  }

  const navigationApi = await emitApiLibrary({
    root: path.join(root, 'node_modules/@bedrock-core/navigation'), entry: 'src/core/api.ts', output: 'dist/core/api.ts',
  });

  await emitApiLibrary({ root, entry: 'probe.ts', output: 'probe.generated.ts' });
  const sourceInputs = new Set();

  for (const role of ['provider', 'consumer']) {
    const namespace = `navigation_${role}`;
    const uuid = randomUUID();
    const authored = { format_version: 3, namespace,
      header: { name: namespace, uuid, version: '1.0.0', min_engine_version: '1.26.50' },
      modules: [{ type: 'script', language: 'javascript', uuid: randomUUID(), version: '1.0.0', entry: 'scripts/main.js' }],
      dependencies: [{ module_name: '@minecraft/server', version: '2.10.0' }, { module_name: '@minecraft/server-ui', version: '2.2.0' }, { module_name: '@minecraft/server-gametest', version: '1.0.0-beta' }],
    };

    await put(path.join(root, `${role}.manifest.json`), authored);
    const native = { ...authored, format_version: 2, header: { ...authored.header, version: [1, 0, 0], min_engine_version: [1, 26, 50] }, modules: authored.modules.map(module => ({ ...module, version: [1, 0, 0] })) };

    delete native.namespace;
    await put(path.join(root, 'packs', role, 'manifest.json'), native);
    const outfile = path.join(root, 'packs', role, 'scripts/main.js');
    const result = await build({ absWorkingDir: root, entryPoints: [`${role}.ts`], outfile, bundle: true, platform: 'neutral', format: 'esm', target: 'es2023', external: ['@minecraft/*'], metafile: true, logLevel: 'silent',
      alias: { '@fixture/navigation-history': path.join(root, 'node_modules/@bedrock-core/navigation/src/runtime/history.ts') } });

    for (const file of Object.keys(result.metafile.inputs)) {
      sourceInputs.add(path.resolve(root, file));
    }

    const runtimes = Object.keys(result.metafile.inputs).filter(file => /server-runtime\/src\/runtime\.ts$/.test(file.replaceAll('\\', '/')));

    assert.equal(runtimes.length, 1, 'Each consumer bundle must use one Core Runtime and metadata registry');
    report.bundles[role] = hash(await readFile(outfile));
    await put(path.join(receipt, `${role}.main.js`), await readFile(outfile, 'utf8'));
  }

  for (const file of sourceInputs) {
    const ownedCopy = path.relative(path.join(root, 'node_modules/@bedrock-core'), file).replaceAll('\\', '/');
    const fixtureCopy = path.relative(root, file).replaceAll('\\', '/');
    let source = file;

    if (file === navigationApi.output) {
      report.generated[fixtureCopy] = hash(await readFile(file));
      continue;
    }

    if (!ownedCopy.startsWith('../') && !path.isAbsolute(ownedCopy) && /^(navigation|ui-runtime)\//.test(ownedCopy)) {
      const [name, ...relative] = ownedCopy.split('/');

      source = path.join(copiedPackages.get(name), ...relative);
    } else if (!fixtureCopy.includes('/') && ['provider.ts', 'consumer.ts', 'probe.ts'].includes(fixtureCopy)) {
      source = path.join(repository, 'fixtures/navigation-api', fixtureCopy);
    } else if (!fixtureCopy.startsWith('../') && !path.isAbsolute(fixtureCopy)) {
      report.generated[fixtureCopy] = hash(await readFile(file));
      continue;
    }

    const sha256 = hash(await readFile(file));

    assert.equal(hash(await readFile(source)), sha256, 'Staged source must match its repository input');
    report.sources[path.relative(repository, source).replaceAll('\\', '/')] = sha256;
  }

  await cp(path.join(repository, 'fixtures/acceptance/packs/BP/structures/builder_acceptance/empty.mcstructure'), path.join(root, 'packs/consumer/structures/navigation_api/empty.mcstructure'), { recursive: true });

  if (process.argv.includes('--native')) {
    const runner = process.env.BUILDER_BDS_RUNNER;

    assert.ok(runner, 'Native acceptance needs BUILDER_BDS_RUNNER pointing to the installed bc-bds.mjs CLI');
    let log = '';
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runner, 'run', '--packs', path.join(root, 'packs'), '--tag', 'navigation_api', '--expect-registered', '1', '--idle', '20', '--timeout', '120', '--offline', '--json', path.join(receipt, 'native.result.json')],
        { cwd: repository, env: { ...process.env, BC_BDS_HOME: process.env.BC_BDS_HOME ?? path.join(repository, '.bds') }, stdio: ['ignore', 'pipe', 'pipe'] });

      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          log += String(chunk);
          process.stdout.write(chunk);
        });
      }

      child.once('error', reject);
      child.once('exit', resolve);
    });

    await put(path.join(receipt, 'native.log'), log);
    report.native = { status, engineVersion: log.match(/Version:\s+([0-9A-Za-z.-]+)/)?.[1] ?? 'unreported' };
    assert.equal(status, 0, 'Headless Navigation API acceptance must pass');
  }

  for (const [file, sha256] of Object.entries(report.sources)) {
    assert.equal(hash(await readFile(path.join(repository, file))), sha256, `Acceptance source changed: ${file}`);
  }

  report.status = 'passed';
  console.log(`Navigation API acceptance passed (${report.native ? 'headless BDS' : 'offline bundles'})`);
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await put(path.join(receipt, 'report.json'), report);
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('navigation-api-'));
  await rm(root, { recursive: true, force: true });
}
