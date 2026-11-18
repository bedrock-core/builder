import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateTypes } from '../src/generate.ts';
import { fixture } from './fixtures.ts';

test('builds semantic document names offline, shares concurrent preparation and repairs its distribution', async (t) => {
  const { root, schemaRoot } = await fixture(t);
  const original = await readFile(path.join(schemaRoot, 'schemas/rp/entity/description.schema.json'), 'utf8');

  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unrequested native metadata must not be downloaded');
  });
  const options = { root, schemaRoot, categories: ['rp/entity'] };
  const results = await Promise.all([generateTypes(options), generateTypes(options)]);

  assert.deepEqual(results.map(result => result.changed).sort(), [false, true]);
  assert.match(await readFile(path.join(root, 'dist/entities/client.d.ts'), 'utf8'), /export interface ClientEntityDocument/);
  assert.match(await readFile(path.join(root, 'dist/common/client-resource.d.ts'), 'utf8'), /\[k: string\]: string/);
  assert.equal(await readFile(path.join(schemaRoot, 'schemas/rp/entity/description.schema.json'), 'utf8'), original);
  await assert.rejects(access(path.join(root, 'dist/internal')), { code: 'ENOENT' });
  await unlink(path.join(root, 'dist/entities/client.d.ts'));
  assert.equal((await generateTypes(options)).changed, true);
  const expanded = await generateTypes({ ...options, categories: ['rp/entity', 'rp/models'] });

  assert.deepEqual(expanded.categories, ['assets/client-resource', 'rp/entity', 'rp/models']);
  assert.match(await readFile(path.join(root, 'dist/models/geometry.d.ts'), 'utf8'), /pivot\?: \[number, number, number\]/);
  await writeFile(path.join(root, 'dist/obsolete.d.ts'), 'export type Obsolete = true;');
  const reduced = await generateTypes(options);

  assert.equal(reduced.changed, true);
  await assert.rejects(access(path.join(root, 'dist/models')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, 'dist/obsolete.d.ts')), { code: 'ENOENT' });
  assert.equal((await generateTypes({ ...options, categories: ['rp/entity', 'rp/entity'] })).changed, false);
});

test('a failed schema build preserves the last successful declarations', async (t) => {
  const { root, schemaRoot } = await fixture(t);
  const options = { root, schemaRoot, categories: ['rp/entity'] };

  await generateTypes(options);
  const file = path.join(root, 'dist/entities/client.d.ts');
  const previous = await readFile(file, 'utf8');

  await writeFile(path.join(schemaRoot, 'catalog.json'), '{"schemas":[]}');
  await assert.rejects(generateTypes(options), /Requested schema category was not compiled/);
  assert.equal(await readFile(file, 'utf8'), previous);
  await assert.rejects(generateTypes({ ...options, categories: ['unknown/document'] }), /public type names/);
});

test('default generation limits its catalog to supported public domains', async (t) => {
  const { root, schemaRoot } = await fixture(t);
  const file = path.join(schemaRoot, 'catalog.json');
  const catalog = JSON.parse(await readFile(file, 'utf8')) as { schemas: { url: string }[] };
  const excluded = ['bp/dialogue', 'bp/functions/tick', 'rp/ui', 'rp/ui/global_variables', 'rp/texts/languages', 'rp/particles'];

  catalog.schemas.push(...excluded.map(key => ({ url: './schemas/' + key + '/index.schema.json' })));
  await writeFile(file, JSON.stringify(catalog));
  const result = await generateTypes({ root, schemaRoot });

  assert.deepEqual(result.categories, ['assets/client-resource', 'rp/entity', 'rp/models']);

  for (const group of ['dialogue', 'functions', 'ui', 'localization', 'particles']) {
    await assert.rejects(access(path.join(root, 'dist', group)), { code: 'ENOENT' });
  }

  for (const category of excluded) {
    await assert.rejects(generateTypes({ root, schemaRoot, categories: [category] }), /public type names/);
  }
});
