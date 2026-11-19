import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRegolithConfig, migrateRegolithProject, writeMigration } from '../src/migrate.ts';
import { validateConfig } from '../src/config.ts';
import { runBuild } from '../src/run.ts';
import { projectFor } from '../test-support/project.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/migrate.ts', import.meta.url));

function legacy() {
  return {
    name: 'example', author: 'Author', targetVersion: '1.26.50',
    packs: { behaviorPack: './packs/BP', resourcePack: './packs/RP' },
    bridge: { retained: true },
    regolith: {
      formatVersion: '1.8.0', dataPath: './packs/data', watchPaths: ['../shared'],
      filterDefinitions: {
        prepare: { runWith: 'nodejs', script: './filters/prepare.js' },
        transform: { runWith: 'nodejs', script: './filters/transform.js' },
      },
      profiles: {
        default: {
          filters: [{ filter: 'prepare' }, { filter: 'transform', settings: { debug: true }, arguments: ['--mode', 'build'] }],
          export: { target: 'local', readOnly: false },
        },
      },
    },
  };
}

async function projectWithRegolith(t) {
  const project = await projectFor(t);
  const config = legacy();

  config.packs = project.config.packs;
  config.regolith.profiles.default.filters = [{ filter: 'transform' }];
  delete config.targetVersion;
  await mkdir(path.join(project.project, 'packs/data'));
  await mkdir(path.join(project.project, 'filters'));
  await writeFile(path.join(project.project, 'packs/data/value.json'), '{"value":42}');
  await writeFile(path.join(project.project, 'filters/transform.js'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    const manifest = JSON.parse(readFileSync('BP/manifest.json', 'utf8'));
    const data = JSON.parse(readFileSync('data/value.json', 'utf8'));
    manifest.modules[0].entry = 'scripts/main.js';
    writeFileSync('BP/manifest.json', JSON.stringify(manifest));
    writeFileSync('BP/scripts/main.js', 'export const value = ' + data.value + ';');
  `);
  await writeFile(project.configPath, JSON.stringify(config));

  return { ...project, legacy: config };
}

const codes = result => result.diagnostics.filter(item => item.severity === 'error').map(item => item.code);

test('migration preserves unrelated tools and Regolith config without mutating input', () => {
  const input = legacy();
  const snapshot = structuredClone(input);
  const result = migrateRegolithConfig(input);

  assert.equal(result.ready, true);
  validateConfig(result.config);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(result.config.regolith, input.regolith);
  assert.deepEqual(result.config.bridge, input.bridge);
  assert.deepEqual(result.config.authors, ['Author']);
  assert.equal(Object.hasOwn(result.config, 'author'), false);
  assert.equal(Object.hasOwn(result.config, 'type'), false);
  assert.equal(Object.hasOwn(result.config, 'worlds'), false);
  const profile = result.config.bedrockCore.profiles.default;

  assert.deepEqual(profile.export, { behaviorPack: 'build/example_bp', resourcePack: 'build/example_rp' });
  assert.deepEqual(profile.watch, { paths: ['../shared'] });
  assert.deepEqual(result.config.bedrockCore.plugins.transform, { script: './filters/transform.js', dataPath: './packs/data' });
  assert.deepEqual(profile.steps, [
    { plugin: 'prepare', after: 'prepare' },
    { plugin: 'transform', after: 'prepare', settings: { debug: true }, arguments: ['--mode', 'build'] },
  ]);
  assert.ok(Object.values(profile.stages).every(value => value === false));
});

test('migration emits preferred metadata without redundant project fields', () => {
  const input = legacy();

  input.type = 'minecraftBedrock';
  input.worlds = ['./worlds/example'];
  input.description = 'Shared project content';
  const result = migrateRegolithConfig(input);

  assert.equal(result.ready, true);
  assert.deepEqual(Object.keys(result.config).slice(0, 5), ['$schema', 'targetVersion', 'name', 'description', 'authors']);
  assert.equal(Object.hasOwn(result.config, 'type'), false);
  assert.equal(Object.hasOwn(result.config, 'worlds'), false);
  assert.equal(input.type, 'minecraftBedrock');
  assert.deepEqual(input.worlds, ['./worlds/example']);
});

test('profile references preserve ordered and repeated script steps and skip disabled filters', () => {
  const config = legacy();

  config.regolith.profiles.shared = { filters: [{ filter: 'transform' }, { filter: 'prepare', disabled: true }] };
  config.regolith.profiles.default.filters = [
    { filter: 'prepare' },
    { profile: 'shared' },
    { profile: 'missing', disabled: true },
    { filter: 'prepare' },
  ];
  const result = migrateRegolithConfig(config, { profiles: ['default'] });

  assert.equal(result.ready, true);
  assert.deepEqual(result.config.bedrockCore.profiles.default.steps.map(step => step.plugin), ['prepare', 'transform', 'prepare']);
  assert.ok(Object.values(result.config.bedrockCore.profiles.default.stages).every(value => value === false));
});

test('exact paths and constant folder expressions convert without evaluation', () => {
  const config = legacy();

  config.regolith.profiles.default.export = { target: 'exact', bpPath: './dist/behavior', rpPath: 'C:/Minecraft/visuals' };
  assert.deepEqual(migrateRegolithConfig(config).config.bedrockCore.profiles.default.export, {
    behaviorPack: './dist/behavior', resourcePack: 'C:/Minecraft/visuals',
  });
  config.regolith.profiles.default.export = [{ target: 'local', bpName: '\'custom-bp\'', rpName: '"custom-rp"' }];
  assert.deepEqual(migrateRegolithConfig(config).config.bedrockCore.profiles.default.export, {
    behaviorPack: 'build/custom-bp', resourcePack: 'build/custom-rp',
  });
});

test('exports can be explicitly replaced with complete per-pack destinations', () => {
  const config = legacy();

  config.regolith.profiles.default.export = { target: 'development', build: 'preview', readOnly: true };
  const exports = { default: { behaviorPack: './dist/BP', resourcePack: './dist/RP' } };
  const result = migrateRegolithConfig(config, { exports });

  assert.equal(result.ready, true);
  assert.deepEqual(result.config.bedrockCore.profiles.default.export, exports.default);
  assert.ok(result.diagnostics.some(item => item.code === 'export-replaced'));
  assert.equal(migrateRegolithConfig(config, { exports: { default: { behaviorPack: './dist/BP' } } }).ready, false);
  assert.equal(migrateRegolithConfig(config, { exports: { missing: exports.default } }).ready, false);
});

test('unsupported behavior is reported rather than dropped or reordered', () => {
  const cases = [
    ['filter-condition', (config) => { config.regolith.profiles.default.filters[0].when = 'os == \'windows\''; }],
    ['shell-commands', (config) => { config.regolith.profiles.default.preShell = ['echo before']; }],
    ['shell-commands', (config) => { config.regolith.profiles.default.postShell = { windows: ['echo after'] }; }],
    ['custom-filter', (config) => { config.regolith.profiles.default.filters = [{ filter: 'unknown' }]; }],
    ['custom-filter', (config) => { config.regolith.filterDefinitions.transform.url = 'github.com/example/filters'; }],
    ['custom-filter', (config) => { config.regolith.filterDefinitions.transform = { npm: '@example/filter', version: '1.0.0' }; }],
    ['filter-runtime', (config) => { config.regolith.filterDefinitions.transform.runWith = 'python'; }],
    ['filter-script', (config) => { delete config.regolith.filterDefinitions.transform.script; }],
    ['filter-arguments', (config) => { config.regolith.profiles.default.filters[0].arguments = [true]; }],
    ['extra-arguments', (config) => { config.regolith.profiles.default.filters[0].extraArguments = 'append'; }],
    ['parallel-filters', (config) => { config.regolith.profiles.default.filters = [{ asyncFilters: [{ filter: 'transform' }] }]; }],
    ['profile-cycle', (config) => { config.regolith.profiles.default.filters = [{ profile: 'default' }]; }],
    ['profile-reference', (config) => { config.regolith.profiles.default.filters = [{ profile: 'missing' }]; }],
    ['filter-settings', (config) => { config.regolith.profiles.default.filters[1].settings = true; }],
    ['export-target', (config) => { config.regolith.profiles.default.export = { target: 'none' }; }],
    ['export-target', (config) => { config.regolith.profiles.default.export = { target: 'world', worldPath: './worlds/test' }; }],
    ['multiple-exports', (config) => { config.regolith.profiles.default.export = [{ target: 'local' }, { target: 'development' }]; }],
    ['readonly-export', (config) => { config.regolith.profiles.default.export.readOnly = true; }],
    ['export-expression', (config) => { config.regolith.profiles.default.export.bpName = 'env.NAME'; }],
    ['export-path', (config) => { config.regolith.profiles.default.export = { target: 'exact', bpPath: '%ROOT%/BP', rpPath: '${ROOT}/RP' }; }],
    ['regolith-version', (config) => { config.regolith.formatVersion = '1.2.0'; }],
    ['regolith-property', (config) => { config.regolith.custom = true; }],
  ];

  for (const [code, change] of cases) {
    const input = legacy();

    change(input);
    const result = migrateRegolithConfig(input);

    assert.equal(result.ready, false, code);
    assert.ok(codes(result).includes(code), `${code}: ${JSON.stringify(result.diagnostics)}`);
  }
});

test('missing metadata is actionable and existing builder profiles are preserved', () => {
  const input = legacy();

  delete input.targetVersion;
  delete input.namespace;
  assert.ok(codes(migrateRegolithConfig(input)).includes('target-version'));
  assert.equal(migrateRegolithConfig(input, { targetVersion: '1.26.50' }).ready, true);
  input.bedrockCore = { custom: 'do not replace' };
  const result = migrateRegolithConfig(input);

  assert.deepEqual(result.config, input);
  assert.deepEqual(codes(result), ['existing-builder']);
});

test('project migration reads v3 manifests and produces a working script build', async (t) => {
  const project = await projectWithRegolith(t);

  delete project.legacy.regolith.dataPath;
  await writeFile(project.configPath, JSON.stringify(project.legacy));
  const source = await readFile(project.configPath, 'utf8');
  const result = await migrateRegolithProject(project.configPath);

  assert.equal(result.ready, true, JSON.stringify(result.diagnostics));
  assert.equal(result.config.targetVersion, '1.26.50');
  assert.deepEqual(result.config.bedrockCore.profiles.default.export, { gameplay: 'build/example_bp', visuals: 'build/example_rp' });
  assert.equal(await readFile(project.configPath, 'utf8'), source);
  const written = await writeMigration(result);

  assert.equal(await readFile(written.backup, 'utf8'), source);
  const build = await runBuild({ configPath: project.configPath });

  assert.match(await readFile(path.join(build.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /value = 42/);
});

test('migration requires the authored script entry to name its source', async (t) => {
  const project = await projectWithRegolith(t);
  const manifestPath = path.join(project.project, 'packs/gameplay/manifest.json');

  project.behavior.modules[0].entry = 'scripts/main.js';
  const authored = JSON.stringify(project.behavior);

  await writeFile(manifestPath, authored);
  const invalid = await migrateRegolithProject(project.configPath);

  assert.equal(invalid.ready, false);
  assert.ok(invalid.diagnostics.some(item => item.code === 'script-entry' && item.message.includes('scripts/main.js')));
  await assert.rejects(writeMigration(invalid), /unresolved errors/);
  assert.equal(await readFile(manifestPath, 'utf8'), authored);
  project.behavior.modules[0].entry = 'scripts/main.ts';
  await writeFile(manifestPath, JSON.stringify(project.behavior));
  const valid = await migrateRegolithProject(project.configPath);

  assert.equal(valid.ready, true, JSON.stringify(valid.diagnostics));
});

test('manifest variants are preserved while invalid versions and unsafe exports block writing', async (t) => {
  const project = await projectWithRegolith(t);
  const config = project.legacy;

  await writeFile(path.join(project.project, 'packs/gameplay/manifest.test.json'), '{}');
  let result = await migrateRegolithProject(project.configPath);

  assert.equal(result.ready, true);
  assert.equal(codes(result).includes('manifest-variants'), false);
  const manifest = { ...project.behavior, format_version: 2 };

  await writeFile(path.join(project.project, 'packs/gameplay/manifest.json'), JSON.stringify(manifest));
  result = await migrateRegolithProject(project.configPath);
  assert.ok(codes(result).includes('pack-manifest'));
  await writeFile(path.join(project.project, 'packs/gameplay/manifest.json'), JSON.stringify(project.behavior));
  config.regolith.profiles.default.export = { target: 'exact', bpPath: '.', rpPath: './dist/visuals' };
  await writeFile(project.configPath, JSON.stringify(config));
  result = await migrateRegolithProject(project.configPath);
  assert.ok(codes(result).includes('export-destinations'));
});

test('write mode preserves source edits and refuses existing backups or outputs', async (t) => {
  const project = await projectWithRegolith(t);
  const result = await migrateRegolithProject(project.configPath);
  const output = path.join(project.project, 'config.builder.json');

  await writeMigration(result, output);
  assert.equal((await writeMigration(result, 'config.relative.json')).path, path.join(project.project, 'config.relative.json'));
  await assert.rejects(writeMigration(result, output), /EEXIST/);
  await assert.rejects(writeMigration(result, path.join(project.root, 'other.json')), /beside/);
  await writeFile(project.configPath, `${result.sourceText}\n`);
  await assert.rejects(writeMigration(result), /changed/);
  assert.equal(await readFile(project.configPath, 'utf8'), `${result.sourceText}\n`);
  await writeFile(project.configPath, result.sourceText);
  await writeFile(`${project.configPath}.regolith.bak`, 'existing backup');
  await assert.rejects(writeMigration(result), /EEXIST/);
  assert.equal(await readFile(`${project.configPath}.regolith.bak`, 'utf8'), 'existing backup');
  assert.equal(await readFile(project.configPath, 'utf8'), result.sourceText);
  assert.ok(!(await readdir(project.project)).some(name => name.includes('.builder-')));
});

test('CLI preview is machine readable and file writes are explicit', async (t) => {
  const project = await projectWithRegolith(t);
  const source = await readFile(project.configPath, 'utf8');
  const preview = JSON.parse((await exec(process.execPath, [cli, project.configPath, '--json'])).stdout);

  assert.equal(preview.ready, true);
  assert.equal(await readFile(project.configPath, 'utf8'), source);
  const output = path.join(project.project, 'config.builder.json');
  const written = JSON.parse((await exec(process.execPath, [cli, project.configPath, '--write', '--output', output, '--json'])).stdout);

  assert.equal(written.written.path, output);
  validateConfig(JSON.parse(await readFile(output, 'utf8')));
  assert.equal(await readFile(project.configPath, 'utf8'), source);
  await assert.rejects(exec(process.execPath, [cli, project.configPath, '--output', output]), /--output requires --write/);
  await assert.rejects(exec(process.execPath, [cli, '--target-version']), /Missing value/);
});

test('CLI reports blocked conversions and leaves source and outputs intact', async (t) => {
  const project = await projectWithRegolith(t);

  project.legacy.regolith.profiles.default.filters = [{ filter: 'unknown' }];
  await writeFile(project.configPath, JSON.stringify(project.legacy));
  const source = await readFile(project.configPath, 'utf8');
  const output = path.join(project.project, 'config.builder.json');

  await assert.rejects(exec(process.execPath, [cli, project.configPath, '--write', '--output', output, '--json']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).ready, false);

    return true;
  });
  assert.equal(await readFile(project.configPath, 'utf8'), source);
  await assert.rejects(readFile(output), /ENOENT/);
});

test('CLI profile, metadata, local filters and per-pack destination options compose', async (t) => {
  const project = await projectWithRegolith(t);
  const config = project.legacy;

  delete config.namespace;
  config.regolith.filterDefinitions.custom = { runWith: 'nodejs', script: './custom.ts' };
  config.regolith.profiles.default.filters = [{ filter: 'custom', settings: { debug: true } }];
  config.regolith.profiles.default.export = { target: 'development' };
  config.regolith.profiles.other = { filters: [{ filter: 'missing' }], export: { target: 'none' } };
  await writeFile(path.join(project.project, 'custom.ts'), 'throw new Error("must never execute");');
  await writeFile(project.configPath, JSON.stringify(config));
  const source = await readFile(project.configPath, 'utf8');
  const response = JSON.parse((await exec(process.execPath, [
    cli, project.configPath, '--profile', 'default', '--target-version', '1.26.51',
    '--export', 'default:gameplay=./dist/BP', '--export', 'default:visuals=./dist/RP',
    '--write', '--output', 'config.builder.json', '--json',
  ])).stdout);

  assert.equal(response.ready, true);
  assert.equal(response.config.namespace, undefined);
  assert.equal(response.config.targetVersion, '1.26.51');
  assert.deepEqual(Object.keys(response.config.bedrockCore.profiles), ['default']);
  assert.deepEqual(response.config.bedrockCore.profiles.default.export, { gameplay: './dist/BP', visuals: './dist/RP' });
  assert.deepEqual(response.config.bedrockCore.profiles.default.steps, [{ plugin: 'custom', after: 'prepare', settings: { debug: true } }]);
  assert.equal(response.written.path, path.join(project.project, 'config.builder.json'));
  assert.equal(await readFile(project.configPath, 'utf8'), source);
});

test('named packs require classification and cannot silently share export destinations', () => {
  const input = legacy();

  input.packs = { constructor: './packs/one', extra: './packs/two' };
  assert.ok(codes(migrateRegolithConfig(input)).includes('export-pack-kind'));
  const packKinds = { constructor: 'resource', extra: 'resource' };

  assert.ok(codes(migrateRegolithConfig(input, { packKinds })).includes('export-collision'));
  const result = migrateRegolithConfig(input, {
    packKinds,
    exports: { default: { constructor: './dist/one', extra: './dist/two' } },
  });

  assert.equal(result.ready, true);
  assert.deepEqual(Object.keys(result.config.bedrockCore.profiles.default.export), ['constructor', 'extra']);
});
