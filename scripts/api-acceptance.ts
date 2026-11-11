import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScriptTarget } from 'typescript-native/ast';
import { API, formatDiagnostics, ModuleKind, ModuleResolutionKind } from 'typescript-native/sync';
import { programDiagnostics } from '../packages/bundler/src/typescript.ts';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../src/run.ts';
import { acceptanceDependencies, linkAcceptanceDependencies } from '../test-support/acceptance.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(repository, 'fixtures/api');
const root = await mkdtemp(path.join(tmpdir(), 'builder-api-'));
const receipt = path.join(repository, '.bedrock-core/api-acceptance');

try {
  const dependencies = acceptanceDependencies(repository, 'api');

  await cp(source, root, { recursive: true, filter: file => path.basename(file) !== 'node_modules' });
  await mkdir(path.join(root, 'node_modules/@bedrock-core'), { recursive: true });

  const link = async (from: string, to: string): Promise<void> => {
    await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir');
  };

  await linkAcceptanceDependencies(root, dependencies, { exclude: ['@bedrock-core/api-provider', '@bedrock-core/api-optional'] });

  for (const name of ['provider', 'optional']) {
    await link(path.join(root, name), path.join(root, 'node_modules/@bedrock-core', `api-${name}`));
  }

  using api = new API({ cwd: root });
  const program = api.createProgram([
    path.join(root, 'provider/packs/BP/api/index.ts'),
    path.join(root, 'provider/packs/BP/scripts/owner.ts'),
    path.join(root, 'consumer/packs/BP/scripts/main.ts'),
  ], {
    target: ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: true, noEmit: true, resolveJsonModule: true, allowImportingTsExtensions: true, types: [],
  });
  const diagnostics = programDiagnostics(program);

  assert.equal(diagnostics.length, 0, formatDiagnostics(diagnostics, api));

  const structures = path.join(root, 'consumer/packs/BP/structures/api');

  await mkdir(structures, { recursive: true });
  await copyFile(path.join(repository, 'fixtures/acceptance/packs/BP/structures/builder_acceptance/empty.mcstructure'), path.join(structures, 'empty.mcstructure'));

  for (const project of ['provider', 'consumer']) {
    const options = { configPath: path.join(root, project, 'config.json'), profile: 'build' };
    const cold = await runBuild(options);
    const warm = await runBuild(options);

    assert.ok(cold.stages.some(stage => stage.stage === 'bundler' && stage.status === 'executed'));
    assert.ok(warm.compilations.every(item => item.status === 'cached'), `${project}: warm compilations must be reused`);
  }

  const consumer = await readFile(path.join(root, 'dist/consumer/scripts/main.js'), 'utf8');
  const nativeManifest = JSON.parse(await readFile(path.join(root, 'dist/consumer/manifest.json'), 'utf8')) as { dependencies: { uuid?: string }[] };

  assert.doesNotMatch(consumer, /function changeCurrency\(|function optionalArgument\(/, 'Provider implementation must stay out of the consumer bundle');
  assert.doesNotMatch(consumer, /provider-implementation-ran-in-consumer/, 'Provider implementation markers must stay out of minified consumer bundles');
  assert.doesNotMatch(consumer, /account-implementation-ran-in-consumer/, 'Account implementations must stay in their owning pack');
  assert.ok(nativeManifest.dependencies.some(dependency => dependency.uuid === '05d80f9a-f9e6-4d46-b92b-7d10b87bdf73'));
  assert.ok(nativeManifest.dependencies.every(dependency => dependency.uuid !== 'c390e0ea-944e-427d-b224-eb79bbd361d0'), 'Optional addons must not create native load requirements');
  await assert.rejects(access(path.join(root, 'dist/provider/api/index.ts')), { code: 'ENOENT' }, 'Authored API source must stay out of the native export');

  if (process.argv.includes('--native')) {
    const cli = process.env.BUILDER_BDS_RUNNER;

    assert.ok(cli, 'Native API acceptance needs BUILDER_BDS_RUNNER pointing to bc-bds.mjs');
    await mkdir(receipt, { recursive: true });

    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', '--packs', path.join(root, 'dist'), '--tag', 'api', '--expect-registered', '7', '--idle', '25', '--timeout', '180', '--offline', '--json', path.join(receipt, 'result.json')], {
        cwd: repository,
        stdio: 'inherit',
        env: { ...process.env, BC_BDS_HOME: process.env.BC_BDS_HOME ?? path.join(repository, '.bds') },
      });

      child.once('error', reject);
      child.once('exit', resolve);
    });

    assert.equal(status, 0, 'Native generated addon API acceptance must pass');
  }

  console.log('@bedrock-core/builder: public addon API acceptance passed');
} finally {
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('builder-api-'));
  await rm(root, { recursive: true, force: true });
}
