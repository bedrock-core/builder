import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runBuild } from '../src/run.ts';
import { parseLang } from '../packages/i18n/src/index.ts';
import { manifestFor } from '../test-support/manifest.js';
import { projectFor } from '../test-support/project.js';
import { put } from '../test-support/i18n.js';

async function fixture(t) {
  const project = await projectFor(t);

  project.config.name = 'Project Name';
  project.config.description = 'Project Description';

  for (const [id, manifest] of [['gameplay', project.behavior], ['visuals', project.resources]]) {
    manifest.header.name = 'pack.name';
    manifest.header.description = 'pack.description';
    await put(project.project, `packs/${id}/manifest.json`, JSON.stringify(manifest));
  }

  await put(project.project, 'config.json', JSON.stringify(project.config));

  return { ...project, options: { configPath: project.configPath, logger: {} } };
}

async function language(result, pack, locale) {
  return readFile(path.join(result.outputPaths[pack], 'texts', `${locale}.lang`), 'utf8');
}

function assertDisplay(content, name, description) {
  const entries = parseLang(content);

  assert.equal(entries['pack.name'], name);
  assert.equal(entries['pack.description'], description);
  assert.equal(content.match(/^pack\.name=/gm)?.length, 1);
  assert.equal(content.match(/^pack\.description=/gm)?.length, 1);
}

test('a sole behavior owner localizes both manifest displays without duplicate defaults on cold and cached builds', async (t) => {
  const project = await fixture(t);
  const locales = {
    en_US: { name: 'Localized Name', description: 'Localized Description' },
    es_ES: { name: 'Nombre', description: 'Descripcion' },
  };

  for (const [locale, meta] of Object.entries(locales)) {
    await put(project.project, `packs/gameplay/i18n/${locale}.ts`, `export default ${JSON.stringify({ meta })} as const;`);
  }

  const first = await runBuild(project.options);
  const snapshot = {};

  for (const pack of ['gameplay', 'visuals']) {
    for (const [locale, meta] of Object.entries(locales)) {
      snapshot[`${pack}:${locale}`] = await language(first, pack, locale);
      assertDisplay(snapshot[`${pack}:${locale}`], meta.name, meta.description);
    }

    const catalog = JSON.parse(await readFile(path.join(first.outputPaths[pack], 'texts/languages.json'), 'utf8'));

    assert.deepEqual(new Set(catalog), new Set(Object.keys(locales)));
  }

  const second = await runBuild(project.options);

  for (const pack of ['gameplay', 'visuals']) {
    for (const locale of Object.keys(locales)) {
      assert.equal(await language(second, pack, locale), snapshot[`${pack}:${locale}`]);
    }
  }

  assert.equal(JSON.parse(await readFile(path.join(project.project, 'packs/visuals/manifest.json'), 'utf8')).header.name, 'pack.name');
});

test('authored pack-specific display names and descriptions override shared translations without duplicate keys', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'packs/gameplay/i18n/en_US.ts', 'export default { meta: { name: "Localized", description: "Translated" } } as const;');
  await put(project.project, 'packs/gameplay/texts/en_US.lang', 'pack.name=Behavior Display\npack.description=Behavior Description\n');
  await put(project.project, 'packs/visuals/texts/en_US.lang', 'pack.name=Resource Display\npack.description=Resource Description\n');
  const result = await runBuild(project.options);

  assertDisplay(await language(result, 'gameplay', 'en_US'), 'Behavior Display', 'Behavior Description');
  assertDisplay(await language(result, 'visuals', 'en_US'), 'Resource Display', 'Resource Description');
});

test('a shared resource pack retains its own manifest display instead of inheriting a behavior owner', async (t) => {
  const project = await fixture(t);
  const secondary = manifestFor('script');

  secondary.header.name = 'pack.name';
  secondary.header.description = 'pack.description';
  secondary.dependencies = [{ pack: 'visuals' }];
  project.config.packs.secondary = './packs/secondary';
  project.config.bedrockCore.profiles.default.export.secondary = './dist/secondary';
  await put(project.project, 'packs/secondary/manifest.json', JSON.stringify(secondary));
  await put(project.project, 'packs/secondary/scripts/main.ts', 'export const value = 2;');

  for (const id of ['gameplay', 'secondary']) {
    await put(project.project, `packs/${id}/i18n/en_US.ts`, 'export default { meta: { name: "Behavior Name", description: "Behavior Description" } } as const;');
  }

  await put(project.project, 'config.json', JSON.stringify(project.config));
  const result = await runBuild(project.options);

  assertDisplay(await language(result, 'visuals', 'en_US'), 'Project Name', 'Project Description');
  assertDisplay(await language(result, 'gameplay', 'en_US'), 'Behavior Name', 'Behavior Description');
  assertDisplay(await language(result, 'secondary', 'en_US'), 'Behavior Name', 'Behavior Description');
});

test('resource-owned locale modules emit their manifest aliases only in their own generated section', async (t) => {
  const project = await fixture(t);

  for (const id of ['gameplay', 'visuals']) {
    await put(project.project, `packs/${id}/i18n/en_US.ts`, 'export default { meta: { name: "Localized Name", description: "Localized Description" } } as const;');
  }

  const result = await runBuild(project.options);
  const resource = await language(result, 'visuals', 'en_US');

  assertDisplay(resource, 'Localized Name', 'Localized Description');
  assert.match(resource, /generated-i18n:begin:visuals>[\s\S]*pack.name=Localized Name/);
  assert.doesNotMatch(resource, /generated-i18n:begin:gameplay>[^]*?pack.name=[^]*?generated-i18n:end:gameplay>/);
});

test('manifest-only builds register the fallback language while preserving authored locale catalogs', async (t) => {
  const project = await fixture(t);

  project.config.bedrockCore.profiles.default.stages.i18n = false;
  await put(project.project, 'config.json', JSON.stringify(project.config));
  await put(project.project, 'packs/visuals/texts/languages.json', '["es_ES"]');
  await put(project.project, 'packs/visuals/texts/es_ES.lang', 'pack.name=Nombre\npack.description=Descripcion\n');
  const result = await runBuild(project.options);

  for (const pack of ['gameplay', 'visuals']) {
    assertDisplay(await language(result, pack, 'en_US'), 'Project Name', 'Project Description');
  }

  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.gameplay, 'texts/languages.json'), 'utf8')), ['en_US']);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outputPaths.visuals, 'texts/languages.json'), 'utf8')), ['es_ES', 'en_US']);
  assertDisplay(await language(result, 'visuals', 'es_ES'), 'Nombre', 'Descripcion');
});
