import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { acceptanceDependencies, installedPackage, linkAcceptanceDependencies } from '../test-support/acceptance.ts';
import { projectFor, put } from '../test-support/project.js';

async function dependenciesFor(t) {
  const { project } = await projectFor(t);
  const fixture = path.join(project, 'fixtures/acceptance');
  const metadata = { private: true, type: 'module', dependencies: { '@fixture/engine': '*', '@fixture/copied': '*' } };

  await put(fixture, 'package.json', JSON.stringify(metadata));

  for (const name of Object.keys(metadata.dependencies)) {
    await put(fixture, `node_modules/${name}/package.json`, JSON.stringify({ name, type: 'module', exports: { '.': { import: './index.js' } } }));
    await put(fixture, `node_modules/${name}/index.js`, 'throw new Error("Dependency discovery must not evaluate package code");');
  }

  const previous = process.env.BUILDER_ACCEPTANCE_DEPENDENCY_ROOT;

  delete process.env.BUILDER_ACCEPTANCE_DEPENDENCY_ROOT;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.BUILDER_ACCEPTANCE_DEPENDENCY_ROOT;
    } else {
      process.env.BUILDER_ACCEPTANCE_DEPENDENCY_ROOT = previous;
    }
  });

  return { project, fixture };
}

test('acceptance stages ESM-only dependencies without evaluating them and preserves installed identities', async (t) => {
  const { project, fixture } = await dependenciesFor(t);
  const dependencies = acceptanceDependencies(project);
  const target = path.join(project, 'staged');

  assert.equal(dependencies.root, fixture);
  assert.equal(installedPackage(dependencies, '@fixture/engine'), realpathSync(path.join(fixture, 'node_modules/@fixture/engine')));
  await linkAcceptanceDependencies(target, dependencies, { exclude: ['@fixture/copied'] });
  assert.equal(realpathSync(path.join(target, 'node_modules/@fixture/engine')), installedPackage(dependencies, '@fixture/engine'));
  assert.equal(existsSync(path.join(target, 'node_modules/@fixture/copied')), false);
});

test('an explicit incomplete dependency project fails instead of falling back to fixture packages', async (t) => {
  const { project } = await dependenciesFor(t);

  process.env.BUILDER_ACCEPTANCE_DEPENDENCY_ROOT = path.join(project, 'missing');
  assert.throws(() => acceptanceDependencies(project), /Acceptance dependencies are missing.*BUILDER_ACCEPTANCE_DEPENDENCY_ROOT/);
});
