import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import ts from 'typescript';
import { projectNameError } from '../src/prompts.ts';
import { replaceVariables } from '../src/utils.ts';
import { configurePackageManager, createProject, initializeGitRepository, installDependencies } from '../src/generator.ts';
import { validateConfig } from '../../../src/config.ts';
import { resolveExportPaths } from '../../../src/export.ts';
import { planBuild } from '../../../src/plan.ts';
import { runBuild } from '../../../src/run.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..');
const templateDir = path.join(packageDir, 'templates', 'bedrock-core');

async function scaffold(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'bedrock-cli-scaffold-'));
  const previous = process.cwd();

  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(https, 'get', () => {
    const request = new EventEmitter();

    request.setTimeout = () => request;
    process.nextTick(() => request.emit('error', new Error('Offline render-pack check')));

    return request;
  });

  try {
    process.chdir(root);
    await createProject('quoted-scaffold', 'O\'Brien', 'Quoted "title", a \\ path and literal $&.', 'none', options);
  } finally {
    process.chdir(previous);
  }

  return path.join(root, 'quoted-scaffold');
}

for (const preset of ['script', 'resource']) {
  test(`${preset} preset builds without Core runtime packages and separates display and stable identity`, async (t) => {
    const root = await scaffold(t, { preset, displayName: 'Human Name', creatorId: 'stable', packId: 'identity' });
    const config = await JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
    const pkg = await JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

    assert.equal(config.name, 'Human Name');
    assert.equal(config.namespace, 'stable_identity');
    assert.equal(Object.hasOwn(config.bedrockCore, 'addon'), false);
    assert.equal(pkg.name, 'quoted-scaffold');
    assert.ok(Object.keys(pkg.dependencies).every(name => !name.startsWith('@bedrock-core/')));
    const result = await runBuild({ configPath: path.join(root, 'config.json'), profile: 'build', logger: {} });

    assert.equal(result.packs.length, 1);
    const packId = preset === 'script' ? 'behaviorPack' : 'resourcePack';

    assert.equal((await JSON.parse(await readFile(path.join(result.outputPaths[packId], 'manifest.json'), 'utf8'))).header.version, pkg.version);
    assert.match(pkg.scripts['build:optimized'], /--packs build --out dist/);
    assert.ok(pkg.devDependencies['@bedrock-core/bds-runner']);

    if (preset === 'script') {
      assert.equal(pkg.scripts.typecheck, 'tsc --noEmit');
      assert.match(await readFile(path.join(result.outputPaths.behaviorPack, 'scripts/main.js'), 'utf8'), /Human Name/);
      const tested = await runBuild({ configPath: path.join(root, 'config.json'), profile: 'build-test', logger: {} });
      const manifest = JSON.parse(await readFile(path.join(tested.outputPaths.behaviorPack, 'manifest.json'), 'utf8'));

      assert.equal(manifest.modules.find(module => module.type === 'script').entry, 'scripts/gametest.js');
      assert.ok(manifest.dependencies.some(dependency => dependency.module_name === '@minecraft/server-gametest'));
      assert.ok(!manifest.dependencies.some(dependency => dependency.pack || dependency.uuid));
      assert.ok(pkg.scripts['test:mc']);
      await assert.rejects(access(path.join(root, 'packs/RP')));
    } else {
      assert.equal((await JSON.parse(await readFile(path.join(result.outputPaths.resourcePack, 'manifest.json'), 'utf8'))).metadata.product_type, undefined);
      assert.equal(pkg.scripts['test:mc'], undefined);
      await assert.rejects(access(path.join(root, 'packs/BP')));
    }
  });
}

test('generated starter validates all builder profiles and escaped metadata', async (t) => {
  const root = await scaffold(t);
  const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  validateConfig(config);
  assert.deepEqual(config.authors, ['O\'Brien']);
  assert.equal(config.description, 'Quoted "title", a \\ path and literal $&.');
  assert.equal(config.namespace, 'o_brien_quoted_scaffold');
  assert.equal(Object.hasOwn(config.bedrockCore, 'addon'), false);
  assert.equal(config.regolith, undefined);
  assert.equal(pkg.scripts['regolith-install'], undefined);
  assert.equal(pkg.scripts.build, 'bc-builder build config.json build');
  assert.equal(pkg.scripts['build:test'], 'bc-builder build config.json build-test');
  assert.equal(pkg.scripts.watch, 'bc-builder watch config.json default');
  assert.equal(pkg.scripts['watch:test'], 'bc-builder watch config.json test');
  assert.match(pkg.dependencies['@bedrock-core/navigation'], /^\d+\.\d+\.\d+$/);
  assert.match(pkg.dependencies['@bedrock-core/ui'], /^\d+\.\d+\.\d+$/);
  assert.match(pkg.scripts['test:mc'], /--packs build\/test --tag example --expect-registered 1/);
  const bds = JSON.parse(await readFile(path.join(root, 'bds-runner.json'), 'utf8'));

  assert.equal(bds.version, '1.26.51.1');
  const home = await readFile(path.join(root, 'packs/BP/scripts/UI/screens/home.screen.tsx'), 'utf8');
  const plan = await readFile(path.join(root, 'packs/BP/scripts/UI/screens/plan.tsx'), 'utf8');

  assert.match(home, /createStaticNavigation\(RootStack\)/);
  assert.match(home, /screen=\{'Plan'\}/);
  assert.match(home, /Profile: `\$\{project\.namespace\}:profile_form`/);
  assert.match(plan, /CommonActions\.goBack\(\)/);
  const registration = await readFile(path.join(root, 'packs/BP/scripts/main.ts'), 'utf8');

  assert.match(registration, /creator: 'o_brien'/);
  assert.match(registration, /pack: 'quoted_scaffold'/);
  assert.match(registration, /version: '1\.0\.0'/);

  for (const profile of ['build', 'default', 'test', 'build-test']) {
    const stages = planBuild(config, profile).filter(step => step.kind === 'stage').map(step => step.stage);

    assert.deepEqual(stages, ['prepare', 'manifest', 'generator', 'guides', 'i18n', 'ui-compiler', 'bundler', 'validate', 'export']);
    const outputs = resolveExportPaths(root, config.packs, config.bedrockCore.profiles[profile].export, { APPDATA: path.join(root, 'appdata') });

    assert.equal(Object.keys(outputs).length, 2);
  }

  const tsconfig = JSON.parse(await readFile(path.join(root, 'tsconfig.json'), 'utf8'));

  assert.equal(tsconfig.compilerOptions.paths, undefined);
  assert.ok(tsconfig.include.includes('.bedrock-core/generated/**/*.d.ts'));
  await access(path.join(root, 'packs/BP/guides/en_US/intro.mdx'));
  await assert.rejects(access(path.join(root, 'guides')));
  const localeSource = await readFile(path.join(root, 'packs/BP/i18n/en_US.ts'), 'utf8');
  const localeJs = ts.transpileModule(localeSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const locale = (await import(`data:text/javascript;base64,${Buffer.from(localeJs).toString('base64')}`)).default;

  assert.equal(locale.meta, undefined);
  assert.ok(locale.example.greeting.includes('{{name}}'));
  await assert.rejects(access(path.join(root, 'packs/data/i18n/en_US.ts')));
});

test('builder selects and bundles the scaffold normal and GameTest manifest entries', async (t) => {
  const root = await scaffold(t);
  const configFile = path.join(root, 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));

  for (const profile of Object.values(config.bedrockCore.profiles)) {
    profile.stages = { ...profile.stages, 'generator': false, 'guides': false, 'i18n': false, 'ui-compiler': false };
  }

  await writeFile(configFile, JSON.stringify(config));
  await writeFile(path.join(root, 'packs/BP/scripts/main.ts'), 'export const entry = "scaffold-normal";\n');
  await writeFile(path.join(root, 'packs/BP/scripts/gametest.ts'), 'import "@minecraft/server-gametest";\nexport const entry = "scaffold-test";\n');
  const normal = await runBuild({ configPath: configFile, profile: 'build', logger: {} });
  const normalPack = normal.outputPaths.behaviorPack;
  const normalManifest = JSON.parse(await readFile(path.join(normalPack, 'manifest.json'), 'utf8'));
  const normalScript = await readFile(path.join(normalPack, 'scripts/main.js'), 'utf8');

  assert.equal(normalManifest.modules.find(module => module.type === 'script').entry, 'scripts/main.js');
  assert.ok(!normalManifest.dependencies.some(dependency => dependency.module_name === '@minecraft/server-gametest'));
  assert.match(normalScript, /scaffold-normal/);
  assert.doesNotMatch(normalScript, /@minecraft\/server-gametest/);
  await assert.rejects(access(path.join(normalPack, 'manifest.test.json')));

  const game = await runBuild({ configPath: configFile, profile: 'build-test', logger: {} });
  const gamePack = game.outputPaths.behaviorPack;
  const gameManifest = JSON.parse(await readFile(path.join(gamePack, 'manifest.json'), 'utf8'));
  const gameScript = await readFile(path.join(gamePack, 'scripts/gametest.js'), 'utf8');

  assert.equal(gameManifest.modules.find(module => module.type === 'script').entry, 'scripts/gametest.js');
  assert.ok(gameManifest.dependencies.some(dependency => dependency.module_name === '@minecraft/server-gametest'));
  assert.match(gameScript, /scaffold-test/);
  assert.match(gameScript, /@minecraft\/server-gametest/);
  assert.equal(gamePack, path.join(root, 'build/test/BP'));
  await assert.rejects(access(path.join(gamePack, 'manifest.test.json')));
});

test('positional project names use the same npm validation as prompts', () => {
  assert.equal(projectNameError('valid-addon'), undefined);
  assert.match(projectNameError('Invalid_Name') ?? '', /lowercase|name|character/i);
});

test('template replacement is literal and single-pass', () => {
  const result = replaceVariables(
    '{{DESCRIPTION}} / {{AUTHOR}} / {{UNKNOWN}}',
    { DESCRIPTION: '$& {{AUTHOR}}', AUTHOR: 'O\'Brien' },
  );

  assert.equal(result, '$& {{AUTHOR}} / O\'Brien / {{UNKNOWN}}');
});

test('published template keeps pack-safe Yarn config and ignores npm lockfiles', async () => {
  const yarnrc = await readFile(path.join(templateDir, 'yarnrc.yml'), 'utf8');
  const eslint = await readFile(path.join(templateDir, 'eslint.config.mjs'), 'utf8');
  const templatePackage = JSON.parse(await readFile(path.join(templateDir, 'package.json'), 'utf8'));

  assert.match(yarnrc, /nodeLinker:\s+node-modules/);
  assert.match(yarnrc, /npmPreapprovedPackages:/);
  assert.match(eslint, /package-lock\.json/);
  const builderPackage = JSON.parse(await readFile(path.resolve(packageDir, '..', '..', 'package.json'), 'utf8'));

  assert.match(templatePackage.dependencies['@bedrock-core/ui'], /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(templatePackage.devDependencies['@bedrock-core/builder'], builderPackage.version.split('-')[0]);
  await assert.rejects(access(path.join(templateDir, '.yarnrc.yml')));
});

test('starter structure is preserved as the reusable server fixture', async () => {
  const templateStructure = await readFile(path.join(
    templateDir,
    'packs', 'BP', 'structures', 'example', 'the_addon_loads.mcstructure',
  ));
  const tests = await readFile(path.join(templateDir, 'packs', 'BP', 'scripts', 'tests', 'index.ts'), 'utf8');
  const digest = createHash('sha256').update(templateStructure).digest('hex');

  assert.equal(templateStructure.length, 480);
  assert.equal(digest, '98203c124f9eec57eff10848ef67aa301ff3c8471cc843cccbf9f014db15f2e9');
  assert.match(tests, /structureName\('example:the_addon_loads'\)/);
});

test('template behavior manifests use the current render-pack version', async () => {
  const templatePackage = JSON.parse(await readFile(path.join(templateDir, 'package.json'), 'utf8'));
  const [major, ...remaining] = templatePackage.dependencies['@bedrock-core/ui'].split('.');
  const renderVersion = [Number(major) + 1, ...remaining].join('.');

  for (const file of ['manifest.json', 'manifest.test.json']) {
    const manifest = JSON.parse(await readFile(path.join(templateDir, 'packs', 'BP', file), 'utf8'));
    const dependency = manifest.dependencies.find(({ uuid }) => uuid === '761ecd37-ad1c-4a64-862a-d6cc38767426');

    assert.equal(dependency?.version, renderVersion);
    assert.equal(dependency?.description, undefined);
  }
});

test('dependency installation follows the selected package manager', async () => {
  const calls = [];

  const run = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
  };

  await installDependencies('yarn', '/project', run);
  assert.deepEqual(calls.splice(0), [
    { command: 'corepack', args: ['enable'], cwd: '/project' },
    { command: 'yarn', args: ['install'], cwd: '/project' },
  ]);

  await installDependencies('npm', '/project', run);
  assert.deepEqual(calls.splice(0), [
    { command: 'npm', args: ['install'], cwd: '/project' },
  ]);

  await installDependencies('pnpm', '/project', run);
  assert.deepEqual(calls.splice(0), [
    { command: 'corepack', args: ['enable'], cwd: '/project' },
    { command: 'corepack', args: ['use', 'pnpm@latest'], cwd: '/project' },
  ]);

  await installDependencies('none', '/project', run);
  assert.deepEqual(calls, []);
});

test('project generation initializes Git without creating a commit', async () => {
  const calls = [];

  const run = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
  };

  assert.equal(await initializeGitRepository('/project', run), true);

  assert.deepEqual(calls, [
    { command: 'git', args: ['init', '--quiet'], cwd: '/project' },
  ]);
});

test('project generation continues when Git is unavailable', async () => {
  assert.equal(await initializeGitRepository('/project', async () => {
    throw new Error('spawn git ENOENT');
  }), false);
});

test('non-Yarn scaffolds do not retain Yarn-only project metadata', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bedrock-cli-manager-'));

  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'test', packageManager: 'yarn@4.18.0' }));
  await writeFile(path.join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

  await configurePackageManager('npm', dir);

  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));

  assert.equal(manifest.packageManager, undefined);
  await assert.rejects(access(path.join(dir, '.yarnrc.yml')));
});

test('Yarn scaffolds have their own project boundary without truncating an existing lock', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bedrock-cli-yarn-'));

  t.after(() => rm(dir, { recursive: true, force: true }));
  await configurePackageManager('yarn', dir);
  assert.equal(await readFile(path.join(dir, 'yarn.lock'), 'utf8'), '');
  await writeFile(path.join(dir, 'yarn.lock'), 'existing lock\n');
  await configurePackageManager('yarn', dir);
  assert.equal(await readFile(path.join(dir, 'yarn.lock'), 'utf8'), 'existing lock\n');
});

test('pnpm scaffolds use a conventional hoisted node_modules layout', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bedrock-cli-pnpm-'));

  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'test', packageManager: 'yarn@4.18.0' }));
  await writeFile(path.join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

  await configurePackageManager('pnpm', dir);

  assert.equal(await readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8'), 'nodeLinker: hoisted\n');
  await assert.rejects(access(path.join(dir, '.yarnrc.yml')));
});

test('skipping installation leaves a manager-neutral manifest', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bedrock-cli-skip-'));

  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'test', packageManager: 'yarn@4.18.0' }));
  await writeFile(path.join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

  await configurePackageManager('none', dir);

  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));

  assert.equal(manifest.packageManager, undefined);
  await access(path.join(dir, '.yarnrc.yml'));
});
