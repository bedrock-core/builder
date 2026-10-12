import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { runBuild } from '../src/run.ts';
import { projectFor } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { put } from '../test-support/i18n.js';

async function fixture(t) {
  const project = await projectFor(t);
  const secondary = manifestFor('script');

  secondary.dependencies = [{ pack: 'visuals' }];
  project.config.packs.secondary = './packs/secondary';
  project.config.bedrockCore.profiles.default.export.secondary = './dist/secondary';
  project.config.bedrockCore.profiles.default.stages.generator = { types: false };
  await put(project.project, 'package.json', '{"type":"module"}');
  await put(project.project, 'packs/secondary/manifest.json', JSON.stringify(secondary));

  for (const [id, key] of [['gameplay', 'alpha'], ['secondary', 'beta']]) {
    await put(project.project, `packs/${id}/i18n/en_US.ts`, `export default { ${key}: "${key} {{value}}" } as const;`);
    await put(project.project, `packs/${id}/scripts/main.ts`, 'import bundle from "@bedrock-core/generated/i18n"; export default bundle;');
  }

  await put(project.project, 'config.json', JSON.stringify(project.config));

  return { ...project, options: { configPath: project.configPath, logger: {} } };
}

test('pack-local sources produce isolated runtime bundles and compose into a shared linked resource pack', async (t) => {
  const project = await fixture(t);

  await put(project.project, 'i18n/en_US.ts', 'throw new Error("Root i18n must not execute");');
  const result = await runBuild(project.options);
  const language = await readFile(path.join(result.outputPaths.visuals, 'texts/en_US.lang'), 'utf8');

  assert.match(language, /flow_test.alpha=alpha %1\$s/);
  assert.match(language, /flow_test.beta=beta %1\$s/);
  assert.match(language, /generated-i18n:begin:gameplay/);
  assert.match(language, /generated-i18n:begin:secondary/);

  for (const [id, key, other] of [['gameplay', 'alpha', 'beta'], ['secondary', 'beta', 'alpha']]) {
    const bundle = (await import(pathToFileURL(path.join(result.outputPaths[id], 'scripts/main.js')).href)).default;

    assert.equal(bundle.locales.en_US[key], `${key} {{value}}`);
    assert.equal(bundle.locales.en_US[other], undefined);
    assert.equal(bundle.extra.en_US?.[`flow_test.${other}`], undefined);
    assert.ok(result.artifacts.some(artifact => artifact.id === `i18n:${id}:bundle` && artifact.pack === id));
    await assert.rejects(access(path.join(result.outputPaths[id], 'i18n')), { code: 'ENOENT' });
    await access(path.join(project.project, `packs/${id}/i18n/en_US.ts`));
  }

  const consumer = await put(project.project, 'check.ts', `
    import alpha from '@bedrock-core/generated/i18n/gameplay';
    import beta from '@bedrock-core/generated/i18n/secondary';
    type Alpha = NonNullable<typeof alpha.resources>;
    type Beta = NonNullable<typeof beta.resources>;
    const a: Alpha['alpha'] = 'alpha {{value}}';
    const b: Beta['beta'] = 'beta {{value}}';
    // @ts-expect-error Resources from another owner are unavailable.
    type Missing = Alpha['beta'];
    void a; void b;
  `);
  const declarations = ['gameplay', 'secondary'].map(id => path.join(project.project, `.bedrock-core/generated/i18n/${id}/i18n.generated.d.ts`));
  const program = ts.createProgram([consumer, ...declarations], { strict: true, noEmit: true, types: [], allowImportingTsExtensions: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });

  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
});

test('pack-local custom source directories are reserved from generation and excluded only after script consumers finish', async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.profiles.default.stages = { generator: { types: false }, i18n: { sourceDir: 'locales' } };
  await put(project.project, 'packs/gameplay/locales/en_US.ts', 'export default { message: "Owned" } as const;');
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'import source from "../locales/en_US"; import bundle from "@bedrock-core/generated/i18n/gameplay"; export const value = { source, bundle };');
  await put(project.project, 'config.json', JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.match(await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /Owned/);
  assert.match(await readFile(path.join(result.outputPaths.visuals, 'texts/en_US.lang'), 'utf8'), /flow_test.message=Owned/);
  await assert.rejects(access(path.join(result.outputPaths.gameplay, 'locales')), { code: 'ENOENT' });
  await access(path.join(project.project, 'packs/gameplay/locales/en_US.ts'));
});

test('conflicting contributions to the same resource keys preserve all previous exports', async (t) => {
  const project = await fixture(t);
  const first = await runBuild(project.options);
  const file = path.join(first.outputPaths.visuals, 'texts/en_US.lang');
  const previous = await readFile(file, 'utf8');

  await put(project.project, 'packs/secondary/i18n/en_US.ts', 'export default { alpha: "Different" };');
  await assert.rejects(runBuild(project.options), /conflicts with generated translation/);
  assert.equal(await readFile(file, 'utf8'), previous);
});

test('the project root does not activate i18n', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'i18n/en_US.ts', 'throw new Error("Root i18n must not execute");');
  await put(project.project, 'config.json', JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(result.stages.find(stage => stage.stage === 'i18n').status, 'skipped');
  assert.ok(!result.artifacts.some(artifact => artifact.id.startsWith('i18n:')));
});
