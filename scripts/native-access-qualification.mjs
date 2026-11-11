import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { acceptanceDependencies, installedPackage } from '../test-support/acceptance.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/native-access-qualification.mjs --server-dir <existing approved BDS directory>\nBUILDER_BDS_RUNNER must point to the installed bc-bds.mjs CLI.');
  process.exit(0);
}

assert.equal(process.platform, 'win32', 'This qualification driver uses the Windows BDS installation');
const args = process.argv.slice(2);

assert.ok(args.length === 2 && args[0] === '--server-dir' && args[1], '--server-dir must identify an existing approved executable directory');
const repository = fileURLToPath(new URL('../', import.meta.url));
const selectedRunner = process.env.BUILDER_BDS_RUNNER;

assert.ok(selectedRunner, 'Native access qualification needs BUILDER_BDS_RUNNER pointing to the installed bc-bds.mjs CLI');
const runner = await realpath(selectedRunner);
const runnerRoot = path.resolve(path.dirname(runner), '..');
const runnerPackage = JSON.parse(await readFile(path.join(runnerRoot, 'package.json'), 'utf8'));

assert.equal(runnerPackage.name, '@bedrock-core/bds-runner', 'BUILDER_BDS_RUNNER must select @bedrock-core/bds-runner');
const serverDir = await realpath(args[1]);
const executable = path.join(serverDir, 'bedrock_server.exe');

assert.ok((await lstat(executable)).isFile(), 'BDS executable is missing');
const output = path.join(repository, '.bedrock-core/native-access-qualification');

await mkdir(output, { recursive: true });
const receipt = await mkdtemp(path.join(output, 'run-'));
const fixture = path.join(receipt, 'fixture');
const worldName = `bc-native-qualification-${path.basename(receipt).toLowerCase()}`;
const worldDir = path.join(serverDir, 'worlds', worldName);
const worlds = path.join(serverDir, 'worlds');
const properties = path.join(serverDir, 'server.properties');
const lock = path.join(serverDir, '.native-access-qualification-lock');
const requireRunner = createRequire(path.join(runnerRoot, 'package.json'));
const { createJiti } = requireRunner('jiti');
const jiti = createJiti(import.meta.url);
const load = file => jiti.import(path.join(runnerRoot, 'src', file));
const { BdsServer } = await load('server/process.ts');
const { renderServerProperties } = await load('server/properties.ts');
const { enableBetaApis, writeWorldPackReferences } = await load('server/world.ts');
const { resetWorldChunks } = await load('server/provision.ts');
const { parseReport, summarise } = await load('report/parse.ts');
const report = { receipt, executable, executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), worldName, engine: null, host: { node: process.version, cpu: cpus()[0]?.model },
  protocol: { runs: 3, samples: 7, loops: 20000, maxRatio: 1.5, minimumDirectMedianMs: 20, order: 'alternating direct/tracked per variant', scope: 'provider native acquisition only; excludes transport, encoding, startup and world generation' },
  conditions: 'Shared Windows host; other activity is not controlled',
  builds: null, runs: [], qualified: false, cleanup: false, errors: [] };
const servers = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const put = (file, value) => writeFile(file, JSON.stringify(value, null, 2));

const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);

  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1), samples: values };
};

const inventory = async (directory, omit = new Set()) => {
  const files = {};

  const visit = async (base) => {
    for (const item of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (omit.has(item.name)) {
        continue;
      }

      assert.ok(!item.isSymbolicLink(), `Unexpected symlink: ${path.join(base, item.name)}`);
      const file = path.join(base, item.name);

      if (item.isDirectory()) {
        await visit(file);
      } else {
        files[path.relative(directory, file).replaceAll('\\', '/')] = hash(await readFile(file));
      }
    }
  };

  await visit(directory);

  return files;
};

const assertIdle = () => {
  const count = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '@(Get-Process -Name bedrock_server -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true }).trim();

  assert.equal(count, '0', 'Another BDS process is running');
};

const start = async (name) => {
  assertIdle();
  const server = new BdsServer({ serverDir, logFile: path.join(receipt, `${name}.log`) });

  servers.push(server);
  await server.start();
  await server.waitForReady(60000);
  assert.ok(server.transcript.includes(`Level Name: ${worldName}`), 'BDS opened a different world');

  return server;
};

let held = false;
let originalProperties;
let originalWorlds;
let mutated = false;

try {
  const { runtimeAliases } = await import('../fixtures/native-access/harness.ts');

  await cp(path.join(repository, 'fixtures/native-access'), fixture, { recursive: true });
  await copyFile(runtimeAliases['@bedrock-core/server-runtime/api/native-access'], path.join(fixture, 'runtime.ts'));
  await copyFile(path.join(repository, 'packages/bundler/src/native-access-transform.ts'), path.join(fixture, 'transform.native.ts'));
  report.sources = await inventory(fixture);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repository, 'scripts/native-access-prototype.mjs'), '--suite', 'qualification', '--build-only', '--retain-packs', '--fixture', fixture, '--output', receipt], {
      cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BUILDER_NATIVE_ACCESS_COMPILER: 'native' },
    });
    let log = '';

    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        log += String(chunk);
      });
    }

    child.once('error', reject);
    child.once('exit', async (code) => {
      try {
        await writeFile(path.join(receipt, 'build.log'), log);
        assert.equal(code, 0, `Fixture build failed:\n${log.slice(-6000)}`);
        resolve();
      } catch (error) { reject(error); }
    });
  });
  report.builds = JSON.parse(await readFile(path.join(receipt, 'report.json'), 'utf8'));
  report.packHashes = await inventory(path.join(receipt, 'packs'));
  const dependencies = acceptanceDependencies(repository, 'acceptance', ['@minecraft/server', '@bedrock-core/server-runtime']);

  report.sdk = JSON.parse(await readFile(path.join(installedPackage(dependencies, '@minecraft/server'), 'package.json'), 'utf8')).version;
  console.log(`Frozen native qualification packs ready: ${receipt}`);
  assertIdle();
  await mkdir(lock);
  held = true;
  await put(path.join(lock, 'owner.json'), { pid: process.pid, receipt, worldName });
  const worldRoot = await lstat(worlds);

  assert.ok(worldRoot.isDirectory() && !worldRoot.isSymbolicLink(), 'Worlds must be a regular directory');
  originalProperties = await readFile(properties);
  await writeFile(path.join(receipt, 'server.properties.original'), originalProperties);
  originalWorlds = await inventory(worlds);
  await cp(worlds, path.join(receipt, 'worlds-backup'), { recursive: true });
  await put(path.join(receipt, 'worlds.original-hashes.json'), originalWorlds);
  assert.ok(!(await readdir(worlds)).includes(worldName), 'Qualification world already exists');
  mutated = true;
  await writeFile(properties, renderServerProperties({ levelName: worldName, port: 19140, portV6: 19141, watchdogHangMs: 60000, lanVisible: false, overrides: { 'level-type': 'FLAT' } }));
  const bootstrap = await start('bootstrap');

  await bootstrap.dispose();
  report.experiments = await enableBetaApis(worldDir);
  const references = [];

  for (const role of ['provider', 'consumer']) {
    const source = path.join(receipt, 'packs', role);
    const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));

    await cp(source, path.join(worldDir, 'behavior_packs', role), { recursive: true });
    references.push({ packId: manifest.header.uuid, version: manifest.header.version });
  }

  await writeWorldPackReferences(worldDir, references, []);

  for (let run = 0; run < 3; run++) {
    assert.equal(path.dirname(worldDir), worlds);
    await resetWorldChunks(worldDir);
    const server = await start(`native-${run + 1}`);

    assert.match(server.transcript, /Experiment\(s\) active:.*gtst/);
    report.engine = server.transcript.match(/Version:\s+(\S+)/)?.[1];
    server.send('gamerule sendcommandfeedback true');
    server.send('tickingarea add 0 -64 0 128 120 128 native_qualification true');
    server.send('execute in overworld positioned 8 -60 8 run gametest runset native_qualification');
    const deadline = Date.now() + 180000;

    for (;;) {
      const parsed = parseReport(server.transcript);

      if (parsed.expected !== null && parsed.passed.length + parsed.failed.length >= parsed.expected) {
        break;
      }

      assert.ok(!server.exited && Date.now() < deadline && !parsed.noTestsForTag, 'Native qualification did not finish');
      assert.equal(parsed.scriptErrors.length, 0, 'Native script exception');
      await delay(100);
    }

    const parsed = parseReport(server.transcript);
    const verdict = summarise(parsed);
    const encoded = server.transcript.match(/NATIVE_ACCESS_QUALIFICATION (\{[^\r\n]+\})/);

    assert.equal(parsed.scriptErrors.length, 0, 'Native script exception');
    assert.equal(verdict.expected, 1);
    assert.ok(verdict.verdicts.length === 1 && verdict.verdicts.every(item => item.outcome === 'pass'), JSON.stringify(verdict));
    assert.ok(encoded, 'Native measurements were not emitted');
    const data = JSON.parse(encoded[1]);
    const cases = data.cases.map((item) => {
      assert.equal(item.loops, report.protocol.loops);
      assert.equal(item.direct.length, 7);
      assert.equal(item.tracked.length, 7);
      assert.deepEqual(item.order, Array.from({ length: 7 }, (_, index) => index % 2 ? [true, false] : [false, true]));
      const direct = summary(item.direct);
      const tracked = summary(item.tracked);
      const ratio = direct.median ? tracked.median / direct.median : null;

      return { variant: item.variant, loops: item.loops, order: item.order, direct, tracked, ratio,
        addedMicrosecondsPerChain: (tracked.median - direct.median) * 1000 / item.loops,
        qualified: direct.median >= report.protocol.minimumDirectMedianMs && ratio !== null && ratio <= report.protocol.maxRatio };
    });

    assert.deepEqual(cases.map(item => item.variant), ['typescript', 'esm', 'commonjs']);
    report.runs.push({ run: run + 1, verdict, cases });
    await server.dispose();
    await put(path.join(receipt, 'qualification.json'), report);
    console.log(JSON.stringify({ run: run + 1, cases: cases.map(item => ({ variant: item.variant, ratio: item.ratio, addedMicrosecondsPerChain: item.addedMicrosecondsPerChain, qualified: item.qualified })) }));
  }

  assert.deepEqual(await inventory(fixture), report.sources);
  assert.equal(hash(await readFile(runtimeAliases['@bedrock-core/server-runtime/api/native-access'])), report.sources['runtime.ts']);
  assert.equal(hash(await readFile(path.join(repository, 'packages/bundler/src/native-access-transform.ts'))), report.sources['transform.native.ts']);
  assert.deepEqual(await inventory(path.join(receipt, 'packs')), report.packHashes);
  report.qualified = report.runs.length === 3 && report.runs.every(run => run.cases.every(item => item.qualified));

  if (!report.qualified) {
    process.exitCode = 1;
  }
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  process.exitCode = 1;
} finally {
  for (const server of servers) {
    await server.dispose();
  }

  if (held) {
    try {
      if (mutated) {
        await writeFile(properties, originalProperties);
      }

      if (originalProperties) {
        assert.equal(hash(await readFile(properties)), hash(originalProperties));
      }

      if (originalWorlds) {
        assert.deepEqual(await inventory(worlds, new Set(mutated ? [worldName] : [])), originalWorlds);
      }

      assert.equal(path.dirname(worldDir), path.join(serverDir, 'worlds'));

      if (mutated) {
        await rm(worldDir, { recursive: true, force: true, maxRetries: 3 });
      }

      assert.equal(path.dirname(lock), serverDir);
      await rm(lock, { recursive: true, force: true });
      report.cleanup = true;
    } catch (error) {
      report.errors.push(`Cleanup: ${String(error.stack ?? error)}`);
      process.exitCode = 1;
    }
  }

  await put(path.join(receipt, 'qualification.json'), report);
  console.log(JSON.stringify({ report: path.join(receipt, 'qualification.json'), qualified: report.qualified, cleanup: report.cleanup, errors: report.errors }, null, 2));
}
