import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRegolithConfig, migrateRegolithProject, writeMigration } from '../src/migrate.ts';
import { localFilterKind } from '../src/migration/local-filter.ts';
import { validateConfig } from '../src/config.ts';
import { runBuild } from '../src/run.ts';
import { projectFor } from '../test-support/project.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/migrate.ts', import.meta.url));

function legacy() {
  return {
    name: 'example', author: 'Author', namespace: 'example', targetVersion: '1.26.50',
    packs: { behaviorPack: './packs/BP', resourcePack: './packs/RP' },
    bridge: { retained: true },
    regolith: {
      formatVersion: '1.8.0', dataPath: './packs/data', watchPaths: ['../shared'],
      filterDefinitions: Object.fromEntries(['core', 'manifest', 'generator', 'i18n', 'bundler', 'guides', 'ui-compiler'].map(id => [id, {
        url: 'github.com/bedrock-core/regolith-filters', version: '1.0.0',
      }])),
      profiles: {
        default: {
          filters: [{ filter: 'manifest' }, { filter: 'bundler', settings: { debug: true, tsConfigPath: 'tsconfig.test.json' } }],
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
  config.regolith.profiles.default.filters = [{ filter: 'bundler' }];
  delete config.targetVersion;
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
  assert.deepEqual(profile.stages.bundler, { debug: true, tsconfig: 'tsconfig.test.json' });
  assert.equal(profile.stages.generator, false);
  assert.equal(profile.stages.i18n, false);
  assert.equal(profile.stages['ui-compiler'], false);
});

test('migration emits preferred metadata without redundant project fields', () => {
  const input = legacy();

  input.type = 'minecraftBedrock';
  input.worlds = ['./worlds/example'];
  input.description = 'Shared project content';
  const result = migrateRegolithConfig(input);

  assert.equal(result.ready, true);
  assert.deepEqual(Object.keys(result.config).slice(0, 6), ['$schema', 'targetVersion', 'namespace', 'name', 'description', 'authors']);
  assert.equal(Object.hasOwn(result.config, 'type'), false);
  assert.equal(Object.hasOwn(result.config, 'worlds'), false);
  assert.equal(input.type, 'minecraftBedrock');
  assert.deepEqual(input.worlds, ['./worlds/example']);
});

test('core settings preserve generator opt-in and infer namespace without enabling absent stages', () => {
  const config = legacy();

  delete config.namespace;
  config.regolith.profiles.default.filters = [{ filter: 'core', settings: {
    'shared': { namespace: 'from_core', pretty: { indent: 'space', size: 2 } },
    'guides': false, 'ui-compiler': false, 'generator': true, 'bundler': { debug: true },
  } }];
  const result = migrateRegolithConfig(config);

  assert.equal(result.ready, true);
  assert.equal(result.config.namespace, 'from_core');
  const stages = result.config.bedrockCore.profiles.default.stages;

  assert.deepEqual(stages.generator, { pretty: { indent: 'space', size: 2 } });
  assert.deepEqual(stages.bundler, { pretty: { indent: 'space', size: 2 }, debug: true });
  assert.equal(stages.i18n.sourceDir, 'i18n');
  assert.equal(stages.i18n.namespace, 'from_core');
  delete config.regolith.profiles.default.filters[0].settings.generator;
  assert.equal(migrateRegolithConfig(config).config.bedrockCore.profiles.default.stages.generator, false);
});

test('referenced profiles flatten and template paths follow authored pack roots', () => {
  const config = legacy();

  config.regolith.profiles.content = {
    filters: [
      { filter: 'generator', settings: { include: ['BP/entities/**/*.ts', './packs/RP/textures/**/*.ts'], exclude: 'BP/entities/helper.ts', types: false } },
      { filter: 'i18n' },
    ],
    export: { target: 'none' },
  };
  config.regolith.profiles.default.filters = [{ profile: 'content' }, { filter: 'bundler' }];
  const result = migrateRegolithConfig(config, { profiles: ['default'] });

  assert.equal(result.ready, true);
  assert.deepEqual(Object.keys(result.config.bedrockCore.profiles), ['default']);
  const stages = result.config.bedrockCore.profiles.default.stages;

  assert.deepEqual(stages.generator.include, ['packs/BP/entities/**/*.ts', 'packs/RP/textures/**/*.ts']);
  assert.equal(stages.generator.exclude, 'packs/BP/entities/helper.ts');
  assert.equal(stages.i18n.sourceDir, 'i18n');
});

test('UI settings migrate local screen modules as project paths and preserve package imports', () => {
  const config = legacy();

  config.regolith.profiles.default.filters = [{ filter: 'ui-compiler', settings: {
    namespace: 'screens', testMetadata: true, stamp: true, pretty: { size: 2 },
    screens: ['./BP/scripts/screens.ts', './data/screens.ts', '@bedrock-core/catalog/compiled'],
  } }];
  const result = migrateRegolithConfig(config);

  assert.equal(result.ready, true);
  validateConfig(result.config);
  assert.deepEqual(result.config.bedrockCore.profiles.default.stages['ui-compiler'], {
    namespace: 'screens', testMetadata: true, stamp: true, pretty: { size: 2 },
    screens: ['./packs/BP/scripts/screens.ts', './packs/data/screens.ts', '@bedrock-core/catalog/compiled'],
  });
  assert.equal(codes(result).length, 0);
});

test('guides settings use owner-relative paths and report guide content requiring placement in a pack', () => {
  const config = legacy();

  config.regolith.profiles.default.filters = [{ filter: 'guides', settings: {
    sourceDir: 'data/manual', screensDir: 'BP/scripts/manual', componentsModule: 'BP/scripts/components.tsx',
    manifestPath: 'data/manual/guides.generated.json', include: ['**/*.mdx'], exclude: ['draft/**'],
    defaultLocale: 'es_ES', strictLocales: true, maxCodeLineBytes: 40, screenTitle: 'Manual',
  } }];
  const result = migrateRegolithConfig(config);

  assert.equal(result.ready, true);
  assert.deepEqual(result.config.bedrockCore.profiles.default.stages.guides, {
    owner: 'behaviorPack', sourceDir: 'guides', screensDir: 'scripts/manual',
    componentsModule: 'scripts/components.tsx',
    include: ['**/*.mdx'], exclude: ['draft/**'], defaultLocale: 'es_ES', strictLocales: true,
    maxCodeLineBytes: 40, screenTitle: 'Manual',
  });
  assert.ok(result.diagnostics.some(item => item.code === 'guides-declarations'));
  assert.ok(result.diagnostics.some(item => item.code === 'guides-pack-sources'));
  assert.ok(result.diagnostics.some(item => item.code === 'guides-pack-output'));
});

test('disabled filters and profile references cannot activate automatic stages', () => {
  const config = legacy();

  config.regolith.profiles.default.filters = [
    { filter: 'bundler', disabled: true, when: 'unknown expression' },
    { profile: 'missing', disabled: true },
    { filter: 'custom', disabled: true },
  ];
  const result = migrateRegolithConfig(config);

  assert.equal(result.ready, true);
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
    ['custom-filter', (config) => { config.regolith.filterDefinitions.bundler.url = 'github.com/other/filters'; }],
    ['custom-filter', (config) => { config.regolith.filterDefinitions.bundler.script = './custom.ts'; }],
    ['filter-arguments', (config) => { config.regolith.profiles.default.filters[0].arguments = ['--test']; }],
    ['extra-arguments', (config) => { config.regolith.profiles.default.filters[0].extraArguments = 'append'; }],
    ['parallel-filters', (config) => { config.regolith.profiles.default.filters = [{ asyncFilters: [{ filter: 'bundler' }] }]; }],
    ['repeated-stage', (config) => { config.regolith.profiles.default.filters.push({ filter: 'bundler' }); }],
    ['stage-order', (config) => { config.regolith.profiles.default.filters.reverse(); }],
    ['profile-cycle', (config) => { config.regolith.profiles.default.filters = [{ profile: 'default' }]; }],
    ['profile-reference', (config) => { config.regolith.profiles.default.filters = [{ profile: 'missing' }]; }],
    ['filter-setting', (config) => { config.regolith.profiles.default.filters[1].settings.entry = 'other.ts'; }],
    ['export-target', (config) => { config.regolith.profiles.default.export = { target: 'none' }; }],
    ['export-target', (config) => { config.regolith.profiles.default.export = { target: 'world', worldPath: './worlds/test' }; }],
    ['multiple-exports', (config) => { config.regolith.profiles.default.export = [{ target: 'local' }, { target: 'development' }]; }],
    ['readonly-export', (config) => { config.regolith.profiles.default.export.readOnly = true; }],
    ['export-expression', (config) => { config.regolith.profiles.default.export.bpName = 'env.NAME'; }],
    ['export-path', (config) => { config.regolith.profiles.default.export = { target: 'exact', bpPath: '%ROOT%/BP', rpPath: '${ROOT}/RP' }; }],
    ['regolith-version', (config) => { config.regolith.formatVersion = '1.2.0'; }],
    ['regolith-property', (config) => { config.regolith.custom = true; }],
    ['builder-config', (config) => { config.regolith.profiles.default.filters[1].settings.debug = 'yes'; }],
    ['generator-pattern', (config) => { config.regolith.profiles.default.filters = [{ filter: 'generator', settings: { include: '**/*.ts' } }]; }],
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
  assert.ok(codes(migrateRegolithConfig(input)).includes('namespace'));
  assert.ok(codes(migrateRegolithConfig(input)).includes('target-version'));
  assert.equal(migrateRegolithConfig(input, { namespace: 'supplied', targetVersion: '1.26.50' }).ready, true);
  input.bedrockCore = { custom: 'do not replace' };
  const result = migrateRegolithConfig(input);

  assert.deepEqual(result.config, input);
  assert.deepEqual(codes(result), ['existing-builder']);
});

test('explicit mappings require verified filter settings and a Node runtime', () => {
  const config = legacy();

  config.regolith.filterDefinitions.local = { runWith: 'nodejs', script: './filters/local.ts' };
  config.regolith.profiles.default.filters = [{ filter: 'local', settings: { debug: true } }];
  const result = migrateRegolithConfig(config, { filters: { local: 'bundler' } });

  assert.equal(result.ready, true);
  assert.deepEqual(result.config.bedrockCore.profiles.default.stages.bundler, { debug: true });
  config.regolith.filterDefinitions.local.runWith = 'python';
  assert.ok(codes(migrateRegolithConfig(config, { filters: { local: 'bundler' } })).includes('filter-runtime'));
});

test('project migration reads v3 manifests and produces a working script build', async (t) => {
  const project = await projectWithRegolith(t);
  const source = await readFile(project.configPath, 'utf8');
  const result = await migrateRegolithProject(project.configPath);

  assert.equal(result.ready, true, JSON.stringify(result.diagnostics));
  assert.equal(result.config.targetVersion, '1.26.50');
  assert.deepEqual(result.config.bedrockCore.profiles.default.export, { gameplay: 'build/example_bp', visuals: 'build/example_rp' });
  assert.equal(await readFile(project.configPath, 'utf8'), source);
  const written = await writeMigration(result);

  assert.equal(await readFile(written.backup, 'utf8'), source);
  const build = await runBuild({ configPath: project.configPath });

  assert.match(await readFile(path.join(build.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /value/);
});

test('local wrapper recognition uses canonical paths and does not execute lookalike scripts', async (t) => {
  const project = await projectWithRegolith(t);
  const config = project.legacy;

  const wrappers = path.join(project.root, 'verified-filters');
  const wrapper = path.join(wrappers, 'bundler/main.ts');

  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(wrapper, 'throw new Error("must never execute");');
  config.regolith.filterDefinitions.bundler = { runWith: 'nodejs', script: wrapper };
  const kind = await localFilterKind(wrapper, wrappers);

  assert.equal(kind, 'bundler');
  await writeFile(project.configPath, JSON.stringify(config));
  assert.equal((await migrateRegolithProject(project.configPath, { filters: { bundler: kind } })).ready, true);
  const fake = path.join(project.project, 'regolith-filters/bundler/main.ts');

  await mkdir(path.dirname(fake), { recursive: true });
  await writeFile(fake, 'throw new Error("must never execute");');
  assert.equal(await localFilterKind(fake, wrappers), undefined);
  config.regolith.filterDefinitions.bundler.script = fake;
  await writeFile(project.configPath, JSON.stringify(config));
  assert.ok(codes(await migrateRegolithProject(project.configPath)).includes('custom-filter'));
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
  await assert.rejects(exec(process.execPath, [cli, '--namespace']), /Missing value/);
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

test('CLI profile, metadata, verified-filter and per-pack destination options compose', async (t) => {
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
    cli, project.configPath, '--profile', 'default', '--namespace', 'migrated', '--target-version', '1.26.51',
    '--filter', 'custom=bundler', '--export', 'default:gameplay=./dist/BP', '--export', 'default:visuals=./dist/RP',
    '--write', '--output', 'config.builder.json', '--json',
  ])).stdout);

  assert.equal(response.ready, true);
  assert.equal(response.config.namespace, 'migrated');
  assert.equal(response.config.targetVersion, '1.26.51');
  assert.deepEqual(Object.keys(response.config.bedrockCore.profiles), ['default']);
  assert.deepEqual(response.config.bedrockCore.profiles.default.export, { gameplay: './dist/BP', visuals: './dist/RP' });
  assert.deepEqual(response.config.bedrockCore.profiles.default.stages.bundler, { debug: true });
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
