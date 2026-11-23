import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../src/config.ts';
import { runBuild } from '../src/run.ts';
import { ContentValidationError } from '../src/validation.ts';
import { acceptanceDependencies } from '../test-support/acceptance.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'builder-acceptance-'));
const source = fileURLToPath(new URL('../fixtures/acceptance', import.meta.url));

try {
  const { modules } = acceptanceDependencies(repository);

  await cp(source, root, { recursive: true, filter: file => path.basename(file) !== 'node_modules' });
  await symlink(modules, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`@bedrock-core/builder: acceptance dependencies: ${modules}`);
  const options = { configPath: path.join(root, 'config.json') };
  const expectedTypes = process.env.BUILDER_EXPECTED_TYPES_VERSION;
  const creatorToolsReport = process.env.BUILDER_CREATOR_TOOLS_REPORT;
  const native = process.argv.includes('--native');
  const config = JSON.parse(await readFile(options.configPath, 'utf8')) as ProjectConfig;

  if (expectedTypes !== undefined) {
    config.bedrockCore.profiles.default.validation = expectedTypes ? 'strict' : 'skip';
    config.bedrockCore.profiles.test.validation = config.bedrockCore.profiles.default.validation;
    await writeFile(options.configPath, JSON.stringify(config, null, 2) + '\n');
  }

  const first = await runBuild(options);

  assert.equal(first.packs.length, 3);
  assert.equal(first.packs.filter(pack => pack.kind === 'resource').length, 2);

  if (expectedTypes !== undefined) {
    assert.equal(first.validation.typesVersion, expectedTypes, 'Builder must validate using the installed Types candidate');
  }

  if (expectedTypes !== '') {
    assert.ok(first.validation.files.some(file => file.category === 'bp/items'));
  }

  const unchanged = await runBuild(options);

  assert.ok(unchanged.compilations.every(item => item.status === 'cached'), JSON.stringify(unchanged.compilations.filter(item => item.status !== 'cached')));
  const entry = path.join(root, 'packs/BP/scripts/main.ts');

  await writeFile(entry, `${await readFile(entry, 'utf8')}\nexport const revision = 2;\n`);
  const scriptEdit = await runBuild(options);

  assert.ok(scriptEdit.compilations.filter(item => item.id.startsWith('generator/')).every(item => item.status === 'cached'));
  assert.equal(scriptEdit.stages.find(stage => stage.stage === 'bundler')?.status, 'executed');
  await writeFile(path.join(root, 'shared/drop.json'), '{"name":"minecraft:bread"}');
  const dataEdit = await runBuild(options);

  assert.equal(dataEdit.compilations.find(item => item.id === 'generator/packs/BP/items/token.ts')?.status, 'cached');
  assert.equal(dataEdit.compilations.find(item => item.id === 'generator/packs/BP/loot_tables/drop.ts')?.status, 'executed');
  await writeFile(path.join(root, 'shared/drop.json'), '{"name":"minecraft:apple"}');

  if (creatorToolsReport) {
    config.bedrockCore.profiles.default.creatorToolsValidation = 'strict';
    await writeFile(options.configPath, JSON.stringify(config, null, 2) + '\n');
  }

  try {
    const { validation } = await runBuild(options);

    if (creatorToolsReport) {
      assert.ok(validation.creatorTools?.rules.length, 'Creator Tools must validate the assembled fixture packs');
      await writeFile(creatorToolsReport, JSON.stringify(validation.creatorTools, null, 2) + '\n');
    }
  } catch (error) {
    if (!creatorToolsReport || !(error instanceof ContentValidationError)) {
      throw error;
    }

    await writeFile(creatorToolsReport, JSON.stringify({ diagnostics: error.diagnostics }, null, 2) + '\n');

    if (!native || error.diagnostics.some(issue => issue.kind !== 'creator-tools')) {
      throw error;
    }

    console.error(error.message);
    process.exitCode = 1;
  }

  if (native) {
    const cli = process.env.BUILDER_BDS_RUNNER;
    const resultFile = process.env.BUILDER_BDS_RESULT;
    const flags = ['--idle', resultFile ? '20' : '1', '--timeout', '180'];

    if (!cli) {
      throw new Error('Native acceptance needs BUILDER_BDS_RUNNER pointing to the installed bc-bds.mjs CLI');
    }

    await runBuild({ ...options, profile: 'test' });

    if (resultFile) {
      const runnerConfig = path.join(root, 'bds-runner.json');

      await writeFile(runnerConfig, '{}\n');
      flags.push('--config', runnerConfig, '--fresh', '--json', resultFile);
    }

    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', '--packs', path.join(root, 'dist/test'), '--tag', 'builder_acceptance', '--expect-registered', '2', ...flags], {
        cwd: repository,
        stdio: 'inherit',
        env: { ...process.env, BC_BDS_HOME: process.env.BC_BDS_HOME ?? path.join(repository, '.bds') },
      });

      child.once('error', reject);
      child.once('exit', resolve);
    });

    assert.equal(status, 0, 'Native GameTest acceptance must pass');

    if (resultFile && process.env.BC_BDS_VERSION) {
      const result = JSON.parse(await readFile(resultFile, 'utf8')) as { bdsVersion: string };

      assert.equal(result.bdsVersion, process.env.BC_BDS_VERSION, 'GameTests must use the resolved BDS build');
    }
  }

  if (!process.exitCode) {
    console.log('@bedrock-core/builder: addon acceptance passed');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
