import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractTgz } from '../packages/bedrock-types/src/inputs/tar.ts';
import { yarn, yarnOutput } from './yarn.ts';
import { defaultRegistryDirectory, registryOrigin, requireRegistry } from './local-registry.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const putJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'resolutions'];

function git(repository, args) {
  return execFileSync('git', ['-c', `safe.directory=${repository}`, '-C', repository, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
}

function inside(root, file) {
  const relative = path.relative(root, file);

  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/** Capture tracked and non-ignored source bytes, including working-tree edits. */
export async function snapshotRepository(repository, destination) {
  repository = await realpath(repository);
  const gitRoot = await realpath(git(repository, ['rev-parse', '--show-toplevel']).trim());

  assert.equal(path.relative(repository, gitRoot), '', '--repo/--consumer must name a repository root');
  const files = [...new Set(git(repository, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const digest = createHash('sha256');
  let count = 0;

  for (const file of files) {
    if (file.split('/').some(part => ['.git', 'node_modules', '.bedrock-core', '.bds', '.npmrc', '.yarnrc'].includes(part) || /^\.env(?:\.|$)/.test(part))) {
      continue;
    }

    let source;

    try {
      source = await realpath(path.join(repository, file));
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    assert.ok(inside(repository, source), 'Source link leaves its repository: ' + file);
    const metadata = await stat(source);

    assert.ok(metadata.isFile(), 'Snapshot input is not a regular file: ' + file);
    const bytes = await readFile(source);
    const target = path.resolve(destination, file);

    assert.ok(inside(destination, target), 'Snapshot path leaves its destination: ' + file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    await chmod(target, metadata.mode & 0o777);
    digest.update(file).update('\0').update(createHash('sha256').update(bytes).digest('hex')).update('\n');
    count++;
  }

  let commit = null;

  try {
    commit = git(repository, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch { /* Unborn development repositories have no base commit. */ }

  return { repository, commit, sha256: digest.digest('hex'), files: count };
}

async function workspaces(directory) {
  const rows = yarnOutput(['workspaces', 'list', '--json'], directory).trim().split('\n').map(line => JSON.parse(line));

  return Promise.all(rows.map(async (row) => {
    const file = path.join(directory, row.location, 'package.json');

    return { ...row, file, manifest: await readJson(file) };
  }));
}

function snapshotPackage(row) {
  return row.manifest.private !== true && row.name !== '@bedrock-core/asset-maps';
}

async function configure(directory, run, endpoint) {
  const manifest = await readJson(path.join(directory, 'package.json'));
  const match = /^yarn@(\d+)\.(\d+)/.exec(manifest.packageManager ?? '');

  assert.ok(match && Number(match[1]) >= 4, 'Local snapshots require a repository-pinned modern Yarn');
  const config = {
    nodeLinker: 'node-modules', enableGlobalCache: false, enableMirror: false,
    cacheFolder: path.join(run, 'cache'), unsafeHttpWhitelist: ['127.0.0.1'],
    npmRegistryServer: 'https://registry.npmjs.org',
    npmScopes: { 'bedrock-core': { npmRegistryServer: registryOrigin(endpoint) } },
  };

  if (Number(match[1]) > 4 || Number(match[2]) >= 12) {
    config.npmMinimalAgeGate = 0;
  }

  await putJson(path.join(directory, '.yarnrc.yml'), config);
}

async function runDirectory(directory, prefix) {
  const parent = path.join(directory, 'runs');

  await mkdir(parent, { recursive: true });

  return mkdtemp(path.join(parent, prefix));
}

function verifyManifest(manifest, endpoint) {
  assert.ok(manifest.name.startsWith('@bedrock-core/') && manifest.private !== true, 'Only public Core packages can be published locally');
  assert.match(manifest.version, /-local\.[0-9a-z.]+$/i, 'Expected a unique local snapshot version');
  assert.equal(manifest.publishConfig.registry, registryOrigin(endpoint), 'Snapshot publishConfig points outside the local registry');

  for (const field of fields) {
    for (const value of Object.values(manifest[field] ?? {})) {
      assert.ok(!/^(?:file|portal|workspace):/.test(value), 'Packed snapshot contains a local dependency protocol');
    }
  }
}

export async function publishSnapshot({ repository, build, directory = defaultRegistryDirectory }) {
  assert.ok(repository && build, 'Specify --repo <producer> and --build <package script>');
  assert.ok(!/^(?:release|publish|tag)(?::|-|$)/.test(build), 'Select a build/pack script, not a publication script');
  const state = await requireRegistry(directory);
  const run = await runDirectory(directory, 'publish-');
  const sourceDirectory = path.join(run, 'source');
  const source = await snapshotRepository(path.resolve(repository), sourceDirectory);
  let rows = await workspaces(sourceDirectory);
  const selected = rows.filter(snapshotPackage);

  assert.ok(selected.length && selected.every(row => row.name.startsWith('@bedrock-core/')), 'Producer contains unexpected public packages');
  const configFile = path.join(sourceDirectory, '.changeset/config.json');
  const config = await readJson(configFile);
  const tag = 'local.' + Date.now() + '.r' + randomBytes(4).toString('hex');

  await putJson(configFile, { ...config, changelog: false, commit: false,
    snapshot: { ...config.snapshot, useCalculatedVersion: true, prereleaseTemplate: '{tag}' } });
  await writeFile(path.join(sourceDirectory, '.changeset/local-snapshot.md'),
    ['---', ...selected.map(row => JSON.stringify(row.name) + ': patch'), '---', '', 'Local package snapshot.', ''].join('\n'));
  execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('@changesets/cli/bin.js')), 'version', '--snapshot', tag], {
    cwd: sourceDirectory, stdio: 'inherit', windowsHide: true,
  });
  rows = await workspaces(sourceDirectory);
  const versions = Object.fromEntries(rows.filter(snapshotPackage).map(row => [row.name, row.manifest.version]));

  for (const row of rows) {
    for (const field of fields) {
      for (const name of Object.keys(row.manifest[field] ?? {})) {
        if (!versions[name]) {
          continue;
        }

        if (field === 'resolutions') {
          delete row.manifest[field][name];
        } else if (!row.manifest[field][name].startsWith('workspace:')) {
          row.manifest[field][name] = versions[name];
        }
      }
    }

    if (snapshotPackage(row)) {
      row.manifest.publishConfig = { ...row.manifest.publishConfig, registry: state.endpoint };
    }

    await putJson(row.file, row.manifest);
  }

  await configure(sourceDirectory, run, state.endpoint);
  console.log('Installing producer snapshot: ' + sourceDirectory);
  yarn(['install', '--no-immutable'], sourceDirectory);
  const root = await readJson(path.join(sourceDirectory, 'package.json'));

  assert.ok(root.scripts?.[build], 'Producer has no build script: ' + build);
  yarn(['run', build], sourceDirectory);
  const archives = path.join(run, 'archives');

  await mkdir(archives);
  const packages = [];

  const publicRows = rows.filter(snapshotPackage);
  const ordered = [];
  const active = new Set();
  const visited = new Set();

  function visit(row) {
    if (visited.has(row.name)) {
      return;
    }

    assert.ok(!active.has(row.name), 'Cyclic snapshot package dependencies: ' + row.name);
    active.add(row.name);

    for (const name of Object.keys(row.manifest.dependencies ?? {})) {
      const dependency = publicRows.find(candidate => candidate.name === name);

      if (dependency) {
        visit(dependency);
      }
    }

    active.delete(row.name);
    visited.add(row.name);
    ordered.push(row);
  }

  publicRows.forEach(visit);

  for (const row of ordered) {
    const file = path.join(archives, row.name.slice('@bedrock-core/'.length) + '.tgz');

    yarn(['workspace', row.name, 'pack', '--out', file], sourceDirectory);
    const bytes = await readFile(file);
    const manifest = JSON.parse(extractTgz(bytes).get('package/package.json').toString('utf8'));

    verifyManifest(manifest, state.endpoint);
    packages.push({ name: manifest.name, version: manifest.version, file, integrity: integrity(bytes) });
  }

  const auth = await readJson(path.join(directory, 'auth.json'));
  const npmrc = path.join(run, 'publish.npmrc');

  await writeFile(npmrc, `registry=${state.endpoint}\n//${new URL(state.endpoint).host}/:_authToken=${auth.token}\n`, { mode: 0o600 });
  const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

  for (const pkg of packages) {
    assert.equal(integrity(await readFile(pkg.file)), pkg.integrity, 'Snapshot archive changed before publication');
    const args = ['publish', pkg.file, '--registry', state.endpoint, '--tag', 'local', '--ignore-scripts', '--provenance=false', '--loglevel', 'warn'];
    const windows = process.platform === 'win32';
    const result = spawnSync(windows ? process.execPath : 'npm', windows ? [npm, ...args] : args, {
      cwd: run, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, npm_config_userconfig: npmrc, NPM_CONFIG_USERCONFIG: npmrc,
        npm_config_registry: state.endpoint, NPM_CONFIG_REGISTRY: state.endpoint,
        npm_config_cache: path.join(run, 'npm-cache'), npm_config_noproxy: '127.0.0.1' },
    });

    assert.equal(result.status, 0, 'Local publication failed: ' + pkg.name);
  }

  const receipt = { schemaVersion: 1, kind: 'local-package-snapshot', registry: state.endpoint, source, tag, directory: run, packages };
  const receiptFile = path.join(run, 'receipt.json');

  await putJson(receiptFile, receipt);
  console.log('Local snapshot receipt: ' + receiptFile);

  return { ...receipt, receiptFile };
}

/** Verify registry bytes and the exact files installed by Yarn. */
export async function verifyInstalledSnapshot(receipt, consumer) {
  const endpoint = registryOrigin(receipt.registry);
  const checked = [];

  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, 'local-package-snapshot');

  for (const pkg of receipt.packages) {
    const bytes = await readFile(pkg.file);

    assert.equal(integrity(bytes), pkg.integrity, 'Snapshot archive changed: ' + pkg.name);
    const metadataResponse = await fetch(endpoint + '/' + encodeURIComponent(pkg.name) + '/' + pkg.version,
      { signal: AbortSignal.timeout(30_000), redirect: 'error' });

    assert.equal(metadataResponse.status, 200, 'Snapshot is missing from the local registry: ' + pkg.name);
    const metadata = await metadataResponse.json();

    assert.equal(metadata.dist.integrity, pkg.integrity, 'Registry integrity differs: ' + pkg.name);
    assert.equal(new URL(metadata.dist.tarball).origin, endpoint, 'Registry archive leaves the loopback registry');
    const response = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(30_000), redirect: 'error' });

    assert.equal(response.status, 200);
    assert.equal(integrity(Buffer.from(await response.arrayBuffer())), pkg.integrity, 'Registry returned different bytes');
    const installed = await realpath(path.join(consumer, 'node_modules', pkg.name));

    assert.ok(inside(path.join(consumer, 'node_modules'), installed), 'Snapshot resolves outside the consumer installation');
    let files = 0;

    for (const [name, value] of extractTgz(bytes)) {
      assert.ok(name.startsWith('package/'));
      const file = path.resolve(installed, name.slice('package/'.length));

      assert.ok(inside(installed, file));
      assert.ok((await readFile(file)).equals(value), 'Installed snapshot file differs: ' + pkg.name + '/' + name);
      files++;
    }

    checked.push({ name: pkg.name, version: pkg.version, integrity: pkg.integrity, files });
  }

  return checked;
}

export async function checkConsumer({ receiptFile, consumer, check, fixture, directory = defaultRegistryDirectory }) {
  assert.ok(receiptFile && consumer && check, 'Specify --receipt <file>, --consumer <repository> and --check <package script>');
  assert.ok(!/^(?:release|publish|tag)(?::|-|$)/.test(check), 'Select a consumer check, not a publication script');
  const state = await requireRegistry(directory);
  const receipt = await readJson(path.resolve(receiptFile));

  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, 'local-package-snapshot');
  assert.ok(Array.isArray(receipt.packages) && receipt.packages.length, 'Snapshot receipt has no packages');
  assert.equal(registryOrigin(receipt.registry), state.endpoint, 'Snapshot belongs to another registry endpoint');

  for (const pkg of receipt.packages) {
    assert.ok(pkg.name.startsWith('@bedrock-core/'));
    assert.equal(integrity(await readFile(pkg.file)), pkg.integrity, 'Snapshot archive changed: ' + pkg.name);
  }

  const run = await runDirectory(directory, 'consumer-');
  const project = path.join(run, 'source');
  const source = await snapshotRepository(path.resolve(consumer), project);
  const rootFile = path.join(project, 'package.json');
  const root = await readJson(rootFile);
  const versions = Object.fromEntries(receipt.packages.map(pkg => [pkg.name, pkg.version]));
  const workspaceNames = new Set((await workspaces(project)).map(row => row.name));
  const fixtureFile = fixture ? path.resolve(project, fixture, 'package.json') : undefined;

  assert.ok(!fixtureFile || inside(project, fixtureFile), 'Fixture path leaves the consumer');
  const extra = fixtureFile ? (await readJson(fixtureFile)).dependencies ?? {} : {};

  assert.ok(Object.keys(versions).every(name => !workspaceNames.has(name)), 'Consumer workspaces shadow the selected registry packages');

  root.devDependencies = { ...root.devDependencies, ...extra, ...versions };
  root.resolutions = { ...root.resolutions, ...versions };
  assert.ok(root.scripts?.[check], 'Consumer has no check script: ' + check);
  await putJson(rootFile, root);
  await configure(project, run, state.endpoint);
  console.log('Installing isolated consumer: ' + project);
  yarn(['install', '--no-immutable'], project);
  yarn(['install', '--immutable', '--check-cache'], project);
  const packages = await verifyInstalledSnapshot(receipt, project);

  yarn(['run', check], project, { ...process.env, BUILDER_ACCEPTANCE_DEPENDENCY_ROOT: project });
  const result = { schemaVersion: 1, kind: 'local-package-consumer', status: 'passed', source,
    producerReceipt: path.resolve(receiptFile), registry: state.endpoint, project, check, packages };
  const resultFile = path.join(run, 'receipt.json');

  await putJson(resultFile, result);
  console.log('Local consumer passed: ' + resultFile);

  return { ...result, receiptFile: resultFile };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  const keys = { '--repo': 'repository', '--build': 'build', '--state': 'directory', '--receipt': 'receiptFile', '--consumer': 'consumer', '--check': 'check', '--fixture': 'fixture' };

  for (let index = 0; index < args.length; index += 2) {
    assert.ok(keys[args[index]] && args[index + 1], 'Unknown or incomplete local-package option: ' + args[index]);
    options[keys[args[index]]] = args[index + 1];
  }

  if (command === 'publish') {
    await publishSnapshot(options);
  } else if (command === 'check') {
    await checkConsumer(options);
  } else {
    throw new Error('Use yarn local:publish or yarn local:check');
  }
}
