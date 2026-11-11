import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runBuild } from '../src/run.ts';
import { parseLang } from '../packages/i18n/src/index.ts';
import { manifestFor } from '../test-support/manifest.js';
import { projectFor, put } from '../test-support/project.js';

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

  for (const [locale, display] of Object.entries(locales)) {
    await put(project.project, `packs/gameplay/i18n/${locale}.ts`, `export default ${JSON.stringify({ pack: display })} as const;`);
  }

  const first = await runBuild(project.options);
  const snapshot = {};

  for (const pack of ['gameplay', 'visuals']) {
    for (const [locale, display] of Object.entries(locales)) {
      snapshot[`${pack}:${locale}`] = await language(first, pack, locale);
      assertDisplay(snapshot[`${pack}:${locale}`], display.name, display.description);
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

  await put(project.project, 'packs/gameplay/i18n/en_US.ts', 'export default { pack: { name: "Localized", description: "Translated" } } as const;');
  await put(project.project, 'packs/gameplay/texts/en_US.lang', 'pack.name=Behavior Display\npack.description=Behavior Description\n');
  await put(project.project, 'packs/visuals/texts/en_US.lang', 'pack.name=Resource Display\npack.description=Resource Description\n');
  const result = await runBuild(project.options);

  assertDisplay(await language(result, 'gameplay', 'en_US'), 'Behavior Display', 'Behavior Description');
  const resourceLanguage = await language(result, 'visuals', 'en_US');

  assertDisplay(resourceLanguage, 'Resource Display', 'Resource Description');
  assert.equal(parseLang(resourceLanguage)['flow_test.pack.name'], 'Behavior Display');
  assert.equal(parseLang(resourceLanguage)['flow_test.pack.description'], 'Behavior Description');
  const warm = await runBuild(project.options);

  assert.equal(await language(warm, 'visuals', 'en_US'), resourceLanguage);
});

test('a shared resource pack retains its own manifest display instead of inheriting a behavior owner', async (t) => {
  const project = await fixture(t);
  const secondary = manifestFor('script', 'scripts/main.ts');

  secondary.namespace = 'flow_secondary';

  secondary.header.name = 'pack.name';
  secondary.header.description = 'pack.description';
  secondary.dependencies = [{ uuid: project.resources.header.uuid }];
  project.config.packs.secondary = './packs/secondary';
  project.config.bedrockCore.profiles.default.export.secondary = './dist/secondary';
  await put(project.project, 'packs/secondary/manifest.json', JSON.stringify(secondary));
  await put(project.project, 'packs/secondary/scripts/main.ts', 'export const value = 2;');

  for (const id of ['gameplay', 'secondary']) {
    await put(project.project, `packs/${id}/i18n/en_US.ts`, 'export default { pack: { name: "Behavior Name", description: "Behavior Description" } } as const;');
  }

  await put(project.project, 'config.json', JSON.stringify(project.config));
  const result = await runBuild(project.options);

  assertDisplay(await language(result, 'visuals', 'en_US'), 'Project Name', 'Project Description');
  assertDisplay(await language(result, 'gameplay', 'en_US'), 'Behavior Name', 'Behavior Description');
  assertDisplay(await language(result, 'secondary', 'en_US'), 'Behavior Name', 'Behavior Description');
});

test('native manifest aliases stay pack-local while shared client display keys isolate owners across locales and cached builds', async (t) => {
  const project = await fixture(t);
  const secondary = manifestFor('script', 'scripts/main.ts');

  secondary.namespace = 'flow_secondary';
  secondary.header.name = 'pack.name';
  secondary.header.description = 'pack.description';
  secondary.dependencies = [{ uuid: project.resources.header.uuid }];
  project.config.packs.secondary = './packs/secondary';
  project.config.bedrockCore.profiles.default.export.secondary = './dist/secondary';
  await put(project.project, 'packs/secondary/manifest.json', JSON.stringify(secondary));
  await put(project.project, 'packs/secondary/scripts/main.ts', 'export const value = 2;');
  const owners = {
    gameplay: { namespace: 'flow_test', en_US: { name: 'Shop', description: 'Trade items' }, es_ES: { name: 'Tienda', description: 'Comercia objetos' } },
    secondary: { namespace: 'flow_secondary', en_US: { name: 'Economy', description: 'Player balances' }, es_ES: { name: 'Economia', description: 'Saldos de jugadores' } },
  };

  for (const [id, owner] of Object.entries(owners)) {
    for (const locale of ['en_US', 'es_ES']) {
      await put(project.project, `packs/${id}/i18n/${locale}.ts`, `export default ${JSON.stringify({ pack: owner[locale] })} as const;`);
    }
  }

  await put(project.project, 'config.json', JSON.stringify(project.config));
  const resourceDisplays = {
    en_US: { name: 'Shared Resources', description: 'Shared client assets' },
    es_ES: { name: 'Recursos compartidos', description: 'Recursos del cliente' },
  };

  for (const [locale, display] of Object.entries(resourceDisplays)) {
    await put(project.project, `packs/visuals/texts/${locale}.lang`, `pack.name=${display.name}\npack.description=${display.description}\n`);
  }

  const authored = await Promise.all(['gameplay', 'secondary', 'visuals'].map(id => readFile(path.join(project.project, `packs/${id}/manifest.json`), 'utf8')));
  let previous;

  for (let pass = 0; pass < 2; pass++) {
    const result = await runBuild(project.options);
    const snapshot = {};

    for (const id of ['gameplay', 'secondary', 'visuals']) {
      const native = JSON.parse(await readFile(path.join(result.outputPaths[id], 'manifest.json'), 'utf8'));

      assert.equal(native.header.name, 'pack.name');
      assert.equal(native.header.description, 'pack.description');
    }

    for (const locale of ['en_US', 'es_ES']) {
      const resource = parseLang(await language(result, 'visuals', locale));

      assertDisplay(await language(result, 'visuals', locale), resourceDisplays[locale].name, resourceDisplays[locale].description);

      for (const [id, owner] of Object.entries(owners)) {
        const display = owner[locale];

        snapshot[`${id}:${locale}`] = await language(result, id, locale);
        assertDisplay(snapshot[`${id}:${locale}`], display.name, display.description);
        assert.equal(resource[`${owner.namespace}.pack.name`], display.name);
        assert.equal(resource[`${owner.namespace}.pack.description`], display.description);
      }

      snapshot[`visuals:${locale}`] = await language(result, 'visuals', locale);
    }

    if (previous) {
      assert.deepEqual(snapshot, previous);
    }

    previous = snapshot;
    assert.deepEqual(await Promise.all(['gameplay', 'secondary', 'visuals'].map(id => readFile(path.join(project.project, `packs/${id}/manifest.json`), 'utf8'))), authored);
  }
});

test('resource-owned locale modules emit their manifest aliases only in their own generated section', async (t) => {
  const project = await fixture(t);

  for (const id of ['gameplay', 'visuals']) {
    await put(project.project, `packs/${id}/i18n/en_US.ts`, 'export default { pack: { name: "Localized Name", description: "Localized Description" } } as const;');
  }

  const result = await runBuild(project.options);
  const resource = await language(result, 'visuals', 'en_US');

  assertDisplay(resource, 'Localized Name', 'Localized Description');
  assert.match(resource, /generated-i18n:begin:visuals>[\s\S]*pack.name=Localized Name/);
  const ownerSection = resource.split('generated-i18n:begin:gameplay>')[1]?.split('generated-i18n:end:gameplay>')[0] ?? '';

  assert.equal(parseLang(ownerSection)['pack.name'], undefined);
  assert.equal(parseLang(ownerSection)['pack.description'], undefined);
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
