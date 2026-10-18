import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { compileGuides, compileGuidePage } from '../packages/guides/src/index.ts';
import { guideScreenModules } from '../packages/guides/src/screens.ts';
import { wrapCodeLines } from '../packages/guides/src/compile.ts';
import { parseLang } from '../packages/guides/src/lang.ts';
import { runBuild } from '../src/run.ts';
import { validateConfig } from '../src/config.ts';
import { guidesFor, guidesOptions, installGuides, exportedModule } from '../test-support/guides.js';
import { put } from '../test-support/i18n.js';
import { manifestFor } from '../test-support/manifest.js';

const optionsFor = project => ({ configPath: project.configPath, logger: {} });
const compiled = (result, file) => result.compilations.find(item => item.id === `guides/page:packs/gameplay/guides/${file}`)?.status;
const stage = (result, name) => result.stages.find(item => item.stage === name)?.status;

test('guide generation selects the resident runtime for every entry and caller-return variant', () => {
  const modules = guideScreenModules({
    pageIds: ['intro', 'chapter'], screensDir: 'scripts/guides', manifestPath: 'generated/guides.json',
    title: 'Guide', components: 'scripts/guide/components.tsx',
  });

  assert.ok(modules.every(module => module.source.includes('import { guideNavigationScreen } from \'@bedrock-core/guides\'')));
  assert.ok(modules.every(module => module.source.includes('import components from "../guide/components"')));
  assert.ok(modules.every(module => !/guide(?:Home|Index|Page)Screen/.test(module.source)));
  const returned = modules.find(module => module.file.endsWith('guideback_page_chapter.screen.tsx'));

  assert.match(returned.source, /entry: \{ page: "chapter" \}, back: true, components/);
  assert.ok(modules.some(module => module.file.endsWith('guideback_index.screen.tsx')));
});

test('standalone guides preserve structural keys, links, locale fallback and handwritten language entries', async (t) => {
  const project = await guidesFor(t);

  await put(project.project, 'packs/gameplay/guides/es_ES/start.mdx', '# Inicio\n\nLee [la siguiente página](./next).\n');
  await put(project.project, 'packs/visuals/texts/en_US.lang', 'manual.key=Kept\n');
  const result = await compileGuides(guidesOptions(project));
  const manifest = result.manifest;

  assert.equal(manifest.v, 1);
  assert.deepEqual(manifest.locales, ['en_US', 'es_ES']);
  assert.equal(manifest.pages.next.next, 'start');
  assert.equal(manifest.pages.start.prev, 'next');
  const linked = manifest.pages.start.blocks[1];

  assert.deepEqual(linked.links, ['next']);
  assert.deepEqual(linked.text, {
    en_US: 'Read §9<0>the next page</0>§r.',
    es_ES: 'Lee §9<0>la siguiente página</0>§r.',
  });
  const english = parseLang(await readFile(path.join(project.project, 'packs/visuals/texts/en_US.lang'), 'utf8'));
  const spanish = parseLang(await readFile(path.join(project.project, 'packs/visuals/texts/es_ES.lang'), 'utf8'));

  assert.equal(english['manual.key'], 'Kept');
  assert.equal(english['flow_test.guides.start.b1'], undefined);
  assert.equal(spanish['flow_test.guides.next.title'], 'Next');
  assert.equal(spanish['flow_test.guides.start.title'], 'Inicio');
  assert.deepEqual(JSON.parse(await readFile(path.join(project.project, 'packs/visuals/texts/languages.json'), 'utf8')), ['en_US', 'es_ES']);
  assert.ok(result.diagnostics.some(item => item.message.includes('untranslated')));
  assert.match(await readFile(result.declarations[0], 'utf8'), / {2}const manifest: import\('@bedrock-core\/builder-guides\/types'\)\.GuideManifest;/);
  const previous = await readFile(result.manifestPath, 'utf8');

  await compileGuides(guidesOptions(project));
  assert.equal(await readFile(result.manifestPath, 'utf8'), previous);
  assert.equal((await readFile(path.join(project.project, 'packs/visuals/texts/en_US.lang'), 'utf8')).split('<core:generated-guides:begin>').length, 2);
});

test('categories, hidden home pages and operator inheritance preserve both navigation chains', async (t) => {
  const project = await guidesFor(t);

  await put(project.project, 'packs/gameplay/guides/en_US/start.mdx', '---\ntitle: Welcome\nhome: true\nhidden: true\n---\nHello.');
  await put(project.project, 'packs/gameplay/guides/en_US/admin/_category_.json', '{"label":"Administration","position":1,"access":"op","link":{"type":"doc","id":"tools"}}');
  await put(project.project, 'packs/gameplay/guides/en_US/admin/tools.mdx', '# Tools\n\nReset.');
  await put(project.project, 'packs/gameplay/guides/en_US/end.mdx', '# End');
  const { manifest } = await compileGuides(guidesOptions(project, { compileScreens: true }));

  assert.equal(manifest.home, 'start');
  assert.equal(manifest.gated, true);
  assert.equal(manifest.pages['admin/tools'].a, 'op');
  assert.equal(manifest.tree[0].a, 'op');
  assert.equal(manifest.tree[0].link, 'admin/tools');
  assert.equal(manifest.pages.end.prev, 'admin/tools');
  assert.equal(manifest.pages.end.pprev, undefined);
  assert.equal(manifest.pages.end.pnext, 'next');
  assert.equal(manifest.screens['admin/tools'], undefined);
  assert.equal(manifest.opScreens['admin/tools'], 'guideop_admin_tools');
  assert.ok(!manifest.tree.some(node => node.id === 'start'));
  const file = path.join(project.project, 'packs/gameplay/scripts/guides/guideop_admin_tools.screen.tsx');

  assert.match(await readFile(file, 'utf8'), /audience: "op"/);
});

test('MDX blocks retain styles, nested lists, admonitions, code wrapping, images and literal components', () => {
  const result = compileGuidePage({
    source: '# Title\n\n#### Deep\n\n**bold** *italic* `code` ~~dim~~\n\n- item\n  - nested\n\n:::warning[Careful]\nDanger.\n:::\n\n```ts\nabcdef ghijkl\n```\n\n![Photo](textures/ui/photo.png)\n\n<Panel n={1} flag label="x" />\n\n---\n',
    pageId: 'page', prefix: 'flow_test.guides', maxCodeLineBytes: 8, imageSize: () => ({ w: 32, h: 16 }),
  });
  const { blocks } = result.page;
  const lang = new Map(result.lang);

  assert.deepEqual(blocks.map(block => block.t), ['h', 'h', 'p', 'ul', 'adm', 'code', 'img', 'cmp', 'hr']);
  assert.equal(blocks[1].l, 3);
  assert.equal(lang.get('flow_test.guides.page.b2'), '§lbold§r §oitalic§r §7code§r §8dim§r');
  assert.equal(blocks[3].items[0].items[0].k, 'flow_test.guides.page.b3.i0.i0');
  assert.equal(lang.get('flow_test.guides.page.b4.t'), '§6§lCareful');
  assert.deepEqual(blocks[5].lines, ['abcdef', 'ghijkl']);
  assert.deepEqual(blocks[6], { t: 'img', src: 'textures/ui/photo', alt: 'Photo', w: 32, h: 16 });
  assert.deepEqual(blocks[7], { t: 'cmp', name: 'Panel', props: { n: 1, flag: true, label: 'x' } });
  assert.ok(result.diagnostics.some(item => item.message.includes('clamped')));
  assert.ok(wrapCodeLines('🦊🦊🦊', 4).every(line => Buffer.byteLength(line) <= 4));
  assert.throws(() => wrapCodeLines('text', 0), /between 4 and 80/);
});

test('MDX import/export and expressions remain warnings and are never executed', () => {
  const result = compileGuidePage({ source: 'import data from "./data.ts";\n\nexport const a = 1;\n\n{process.exit(1)}\n\nText [web](https://example.com).', pageId: 'page', prefix: 'test.guides', maxCodeLineBytes: 60 });

  assert.equal(result.page.blocks.length, 1);
  assert.equal(result.diagnostics.filter(item => item.level === 'warning').length, 3);
  assert.deepEqual(result.targets, []);
});

test('strict locale drift, parse failures and broken links preserve every existing output', async (t) => {
  const project = await guidesFor(t);
  const first = await compileGuides(guidesOptions(project));
  const before = await readFile(first.manifestPath, 'utf8');
  const language = await readFile(path.join(project.project, 'packs/visuals/texts/en_US.lang'), 'utf8');

  await put(project.project, 'packs/gameplay/guides/es_ES/start.mdx', '# Inicio');
  await assert.rejects(compileGuides(guidesOptions(project, { strictLocales: true })), /untranslated keys/);
  await rm(path.join(project.project, 'packs/gameplay/guides/es_ES'), { recursive: true });
  await put(project.project, 'packs/gameplay/guides/en_US/start.mdx', '# Start\n\n[Broken](./absent)');
  await assert.rejects(compileGuides(guidesOptions(project)), /broken internal link/);
  await put(project.project, 'packs/gameplay/guides/en_US/start.mdx', '<Unclosed>');
  await assert.rejects(compileGuides(guidesOptions(project)), /parse error/);
  assert.equal(await readFile(first.manifestPath, 'utf8'), before);
  assert.equal(await readFile(path.join(project.project, 'packs/visuals/texts/en_US.lang'), 'utf8'), language);
});

test('guide screen outputs are repeatable, remove owned stale pages and preserve authored files', async (t) => {
  const project = await guidesFor(t);
  const options = guidesOptions(project, { compileScreens: true });

  await compileGuides(options);
  await compileGuides(options);
  await put(project.project, 'packs/gameplay/scripts/guides/authored.screen.tsx', 'export default () => {};');
  await rm(path.join(project.project, 'packs/gameplay/guides/en_US/start.mdx'));
  await compileGuides(options);
  const files = await readdir(path.join(project.project, 'packs/gameplay/scripts/guides'));

  assert.ok(files.includes('authored.screen.tsx'));
  assert.ok(!files.includes('guide_start.screen.tsx'));
  await put(project.project, 'packs/gameplay/scripts/guides/guide_next.screen.tsx', 'export default () => {};');
  await assert.rejects(compileGuides(options), /overwrite an existing file/);
});

test('guide path constraints, duplicate pages and folded screen names fail clearly', async (t) => {
  const project = await guidesFor(t);

  await assert.rejects(compileGuides(guidesOptions(project, { sourceDir: '..' })), /sourceDir/);
  await assert.rejects(compileGuides(guidesOptions(project, { compileScreens: true, screensDir: 'outside' })), /screensDir/);
  await assert.rejects(compileGuides(guidesOptions(project, { defaultLocale: 'fr_FR' })), /default locale/);
  await put(project.project, 'packs/gameplay/guides/en_US/next.mdx', '# Duplicate');
  await assert.rejects(compileGuides(guidesOptions(project)), /more than one source/);
  assert.throws(() => guideScreenModules({ pageIds: ['a-b', 'a_b'], screensDir: 'BP/scripts/guides', manifestPath: 'guides.json', title: 'Guide' }), /both compile to the screen/);
  assert.throws(() => guideScreenModules({ pageIds: ['home'], screensDir: 'BP/scripts/guides', manifestPath: 'guides.json', title: 'Guide' }), /both compile to the screen/);
});

test('include and exclude patterns select pages per locale and missing content is a no-op', async (t) => {
  const project = await guidesFor(t);
  const result = await compileGuides(guidesOptions(project, { include: ['*.md'], exclude: ['ignored.*'] }));

  assert.deepEqual(Object.keys(result.manifest.pages), ['next']);
  assert.equal((await compileGuides(guidesOptions(project, { sourceDir: 'absent' }))).manifest, undefined);
  await put(project.project, 'packs/gameplay/guides/en_US/_category_.json', '[]');
  await assert.rejects(compileGuides(guidesOptions(project)), /invalid _category_/);
});

test('automatic guides, i18n, UI and bundler share artifacts without extra stage or alias config', async (t) => {
  const project = await guidesFor(t, { screens: true });

  await installGuides(project.project);
  await put(project.project, 'packs/gameplay/guides/es_ES/start.mdx', '# Inicio\n\nLee [la siguiente página](./next).');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `
    import manifest from '@bedrock-core/generated/guides';
    import translations from '@bedrock-core/generated/i18n';
    export const value = { manifest, translations };
  `);
  const result = await runBuild(optionsFor(project));
  const { value } = await exportedModule(result);

  for (const name of ['guides', 'i18n', 'ui-compiler', 'bundler']) {
    assert.equal(stage(result, name), 'executed');
  }

  assert.equal(value.manifest.ns, 'flow_test');
  assert.equal(value.translations.extra.en_US['flow_test.guides.next.b1'], 'More information.');
  assert.equal(value.translations.extra.es_ES['flow_test.guides.start.title'], 'Inicio');
  assert.equal(value.translations.locales.en_US['core.guides.adm.note'], 'Note');
  assert.equal(result.artifacts.find(item => item.id === 'guides:gameplay:manifest').importAs, '@bedrock-core/generated/guides');
  assert.ok(result.artifacts.some(item => item.id === 'ui:bundle'));
  assert.match(await readFile(path.join(result.outputPaths.visuals, 'ui/core-ui/screens/flow_test/guide_start.json'), 'utf8'), /guide_start/);
  assert.ok(!await readFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'utf8').then(source => source.includes('import \'@bedrock-core/generated/ui\'')));
  const second = await runBuild(optionsFor(project));

  assert.equal(stage(second, 'guides'), 'cached');
  assert.equal(stage(second, 'ui-compiler'), 'cached');
  assert.equal(stage(second, 'bundler'), 'cached');
});

test('generated guide screen sources are validated but omitted from cold and cached exports', async (t) => {
  const project = await guidesFor(t, { screens: true });

  await installGuides(project.project);
  await put(project.project, 'packs/gameplay/scripts/main.ts', `export { default as value } from '@bedrock-core/generated/guides';`);
  let validated = 0;

  for (const expected of ['executed', 'cached']) {
    const result = await runBuild({
      ...optionsFor(project),
      async validateArtifacts(context) {
        const screen = context.artifact('guides:gameplay:gameplay:scripts/guides/guide_start.screen.tsx');

        assert.match(await readFile(screen.path, 'utf8'), /guideNavigationScreen/);
        validated++;
      },
    });

    assert.equal(stage(result, 'guides'), expected);
    await assert.rejects(readFile(path.join(result.outputPaths.gameplay, 'scripts/guides/guide_start.screen.tsx')), { code: 'ENOENT' });
    assert.match(await readFile(path.join(result.outputPaths.visuals, 'ui/core-ui/screens/flow_test/guide_start.json'), 'utf8'), /guide_start/);
    assert.equal((await exportedModule(result)).value.ns, 'flow_test');
  }

  assert.equal(validated, 2);
});

test('guides cache pages individually across script edits, translations and category changes', async (t) => {
  const project = await guidesFor(t);
  const options = optionsFor(project);

  await put(project.project, 'packs/gameplay/guides/es_ES/next.md', '# Siguiente\n\nMás información.');
  await runBuild(options);
  await put(project.project, 'packs/gameplay/scripts/main.ts', 'export const value = 2;');
  const script = await runBuild(options);

  assert.equal(compiled(script, 'en_US/start.mdx'), 'cached');
  assert.equal(compiled(script, 'en_US/next.md'), 'cached');
  await put(project.project, 'packs/gameplay/guides/en_US/next.md', '# Next\n\nChanged information.');
  const page = await runBuild(options);

  assert.equal(compiled(page, 'en_US/start.mdx'), 'cached');
  assert.equal(compiled(page, 'en_US/next.md'), 'executed');
  assert.equal(compiled(page, 'es_ES/next.md'), 'cached');
  await put(project.project, 'packs/gameplay/guides/en_US/_category_.json', '{"access":"op"}');
  const category = await runBuild(options);

  assert.equal(stage(category, 'guides'), 'cached');
  assert.match(await readFile(path.join(category.outputPaths.visuals, 'texts/en_US.lang'), 'utf8'), /Changed information/);
  await put(project.project, 'packs/gameplay/guides/es_ES/next.md', '# Siguiente\n\nInformación diferente.');
  const translated = await runBuild(options);

  assert.equal(compiled(translated, 'es_ES/next.md'), 'executed');
  assert.equal(compiled(translated, 'en_US/next.md'), 'cached');
});

test('cached links validate page removals and failed rebuilds preserve the previous export', async (t) => {
  const project = await guidesFor(t);
  const options = optionsFor(project);
  const first = await runBuild(options);
  const previous = await readFile(path.join(first.outputPaths.visuals, 'texts/en_US.lang'), 'utf8');

  await rm(path.join(project.project, 'packs/gameplay/guides/en_US/next.md'));
  await assert.rejects(runBuild(options), /broken internal link/);
  assert.equal(await readFile(path.join(first.outputPaths.visuals, 'texts/en_US.lang'), 'utf8'), previous);
  await put(project.project, 'packs/gameplay/guides/en_US/next.md', '# Next\n\nMore information.\n');
  await put(project.project, 'packs/gameplay/guides/en_US/added.md', '# Added');
  const restored = await runBuild(options);

  assert.equal(compiled(restored, 'en_US/start.mdx'), 'cached');
  assert.equal(compiled(restored, 'en_US/next.md'), 'cached');
  assert.equal(compiled(restored, 'en_US/added.md'), 'executed');
});

test('texture dimensions invalidate only pages using that resource, including newly added images', async (t) => {
  const project = await guidesFor(t);
  const options = optionsFor(project);

  await put(project.project, 'packs/gameplay/guides/en_US/next.md', '# Next\n\n![Photo](textures/photo.png)');
  await runBuild(options);
  const png = Buffer.alloc(24);

  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(40, 16);
  png.writeUInt32BE(20, 20);
  await put(project.project, 'packs/visuals/textures/photo.png', png);
  const added = await runBuild(options);

  assert.equal(compiled(added, 'en_US/start.mdx'), 'cached');
  assert.equal(compiled(added, 'en_US/next.md'), 'executed');
  png.writeUInt32BE(80, 16);
  await put(project.project, 'packs/visuals/textures/photo.png', png);
  const resized = await runBuild(options);

  assert.equal(compiled(resized, 'en_US/start.mdx'), 'cached');
  assert.equal(compiled(resized, 'en_US/next.md'), 'executed');
});

test('guides support a resource-only content build, multiple resources and disabled reuse', async (t) => {
  const project = await guidesFor(t);

  project.config.packs.other = './packs/other';
  project.config.bedrockCore.profiles.default.export.other = './dist/other';
  project.config.bedrockCore.profiles.default.cache = false;
  await put(project.project, 'packs/other/manifest.json', JSON.stringify(manifestFor('resources')));
  await cp(path.join(project.project, 'packs/gameplay/guides'), path.join(project.project, 'packs/visuals/guides'), { recursive: true });
  delete project.config.packs.gameplay;
  delete project.config.bedrockCore.profiles.default.export.gameplay;
  project.config.bedrockCore.profiles.default.stages.guides = { owner: 'visuals', compileScreens: false };
  project.config.bedrockCore.profiles.default.stages.i18n = { owner: 'visuals' };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await runBuild(optionsFor(project));
  const result = await runBuild(optionsFor(project));

  assert.equal(stage(result, 'guides'), 'executed');
  assert.match(await readFile(path.join(result.outputPaths.visuals, 'texts/en_US.lang'), 'utf8'), /flow_test/);
  await assert.rejects(readFile(path.join(result.outputPaths.other, 'texts/en_US.lang')), { code: 'ENOENT' });
});

test('project-root guides are ignored by the builder and remain available to standalone callers', async (t) => {
  const project = await guidesFor(t);

  await cp(path.join(project.project, 'packs/gameplay/guides'), path.join(project.project, 'guides'), { recursive: true });
  await rm(path.join(project.project, 'packs/gameplay/guides'), { recursive: true });
  project.config.bedrockCore.profiles.default.stages = {};
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild(optionsFor(project));

  assert.equal(stage(result, 'guides'), 'skipped');
  assert.ok(!result.artifacts.some(item => item.id.startsWith('guides:')));
  const standalone = await compileGuides(guidesOptions(project, { sourceDir: undefined }));

  assert.deepEqual(Object.keys(standalone.manifest.pages), ['next', 'start']);
  assert.match(await readFile(standalone.declarations[0], 'utf8'), /declare module "@bedrock-core\/generated\/guides"/);
});

test('pack-relative guide directories reserve components from generators and omit authored inputs from export', async (t) => {
  const project = await guidesFor(t);

  project.config.bedrockCore.profiles.default.stages.guides = { sourceDir: 'manual', compileScreens: false, include: ['*.mdx'] };
  await put(project.project, 'packs/gameplay/manual/en_US/intro.mdx', '# Manual');
  await put(project.project, 'packs/gameplay/manual/components.ts', 'throw new Error("Guide components must not execute as templates");');
  await put(project.project, 'packs/gameplay/scripts/main.ts', `import manifest from '@bedrock-core/generated/guides'; export const value = manifest;`);
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild(optionsFor(project));
  const artifact = result.artifacts.find(item => item.id === 'guides:gameplay:manifest');
  const { value } = await exportedModule(result);

  assert.equal(stage(result, 'generator'), 'skipped');
  assert.equal(stage(result, 'guides'), 'executed');
  assert.ok(artifact);
  assert.deepEqual(Object.keys(value.pages), ['intro']);
  await assert.rejects(readFile(path.join(result.outputPaths.gameplay, 'manual/en_US/intro.mdx')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(result.outputPaths.gameplay, 'manual/components.ts')), { code: 'ENOENT' });
  assert.ok(result.dependencies.includes(path.join(project.project, 'packs/gameplay/manual')));
});

async function addGuidePack(project, { shared = false, page = 'next', title = 'Other guide' } = {}) {
  const resource = shared ? project.resources : manifestFor('resources');
  const behavior = manifestFor('script');

  behavior.dependencies = [{ uuid: resource.header.uuid, version: resource.header.version }];
  project.config.packs.other = './packs/other';
  project.config.bedrockCore.profiles.default.export.other = './dist/other';
  await put(project.project, 'packs/other/manifest.json', JSON.stringify(behavior));
  await put(project.project, `packs/other/guides/en_US/${page}.md`, `# ${title}`);
  await put(project.project, 'packs/other/scripts/main.ts', `import manifest from '@bedrock-core/generated/guides'; export const value = manifest;`);

  if (!shared) {
    project.config.packs.otherAssets = './packs/otherAssets';
    project.config.bedrockCore.profiles.default.export.otherAssets = './dist/otherAssets';
    await put(project.project, 'packs/otherAssets/manifest.json', JSON.stringify(resource));
  }

  await put(project.project, 'packs/gameplay/scripts/main.ts', `import manifest from '@bedrock-core/generated/guides'; export const value = manifest;`);
  await writeFile(project.configPath, JSON.stringify(project.config));
}

test('multiple guide owners have separate runtime imports, declarations and linked resource output', async (t) => {
  const project = await guidesFor(t);

  await addGuidePack(project);
  const result = await runBuild(optionsFor(project));
  const otherCode = await readFile(path.join(result.outputPaths.other, 'scripts/main.js'), 'utf8');
  const other = await import(`data:text/javascript;base64,${Buffer.from(otherCode).toString('base64')}`);
  const gameplay = await exportedModule(result);

  assert.deepEqual(Object.keys(gameplay.value.pages), ['next', 'start']);
  assert.deepEqual(Object.keys(other.value.pages), ['next']);
  assert.equal(parseLang(await readFile(path.join(result.outputPaths.visuals, 'texts/en_US.lang'), 'utf8'))['flow_test.guides.next.title'], 'Next');
  assert.equal(parseLang(await readFile(path.join(result.outputPaths.otherAssets, 'texts/en_US.lang'), 'utf8'))['flow_test.guides.next.title'], 'Other guide');

  for (const owner of ['gameplay', 'other']) {
    const declaration = await readFile(path.join(project.project, '.bedrock-core/generated/guides', owner, 'guides.generated.d.ts'), 'utf8');

    assert.ok(declaration.includes(`"@bedrock-core/generated/guides/${owner}"`));
    assert.ok(!declaration.includes('"@bedrock-core/generated/guides"'));
    assert.equal(result.artifacts.find(item => item.id === `guides:${owner}:manifest`).importAs, '@bedrock-core/generated/guides');
    await assert.rejects(readFile(path.join(result.outputPaths[owner], 'guides/en_US/next.md')), { code: 'ENOENT' });
  }

  const warm = await runBuild(optionsFor(project));

  assert.equal(stage(warm, 'guides'), 'cached');
  assert.equal(stage(warm, 'bundler'), 'cached');
});

test('guide owners sharing a resource pack preserve independent language contributions', async (t) => {
  const project = await guidesFor(t);

  await addGuidePack(project, { shared: true, page: 'other', title: 'Other guide' });
  await put(project.project, 'packs/visuals/texts/en_US.lang', 'manual.key=Keep trailing space \n');
  await runBuild(optionsFor(project));
  await put(project.project, 'packs/other/guides/en_US/other.md', '# Updated guide');
  const result = await runBuild(optionsFor(project));
  const language = await readFile(path.join(result.outputPaths.visuals, 'texts/en_US.lang'), 'utf8');

  assert.match(language, /manual.key=Keep trailing space \n/);
  assert.match(language, /flow_test.guides.next.title=Next/);
  assert.match(language, /flow_test.guides.other.title=Updated guide/);
  assert.equal(language.split('<core:generated-guides:begin:gameplay>').length, 2);
  assert.equal(language.split('<core:generated-guides:begin:other>').length, 2);
  assert.equal(compiled(result, 'en_US/start.mdx'), 'cached');
});

test('conflicting guide keys in a shared resource destination fail without replacing exported packs', async (t) => {
  const project = await guidesFor(t);
  const first = await runBuild(optionsFor(project));
  const previous = await readFile(path.join(first.outputPaths.visuals, 'texts/en_US.lang'), 'utf8');

  await addGuidePack(project, { shared: true });
  await assert.rejects(runBuild(optionsFor(project)), /Conflicting guide translation for flow_test\.guides\.next\./);
  assert.equal(await readFile(path.join(first.outputPaths.visuals, 'texts/en_US.lang'), 'utf8'), previous);
});

test('builder guides reject source paths outside their owner and outputs inside reserved sources', async (t) => {
  const project = await guidesFor(t);

  for (const [settings, error] of [
    [{ sourceDir: '../outside' }, /sourceDir.*inside owner pack/],
    [{ owner: 'missing' }, /owner.*selected/],
    [{ manifestPath: 'guides/runtime.json' }, /manifestPath.*outside the source/],
    [{ compileScreens: true, screensDir: 'guides/screens' }, /screensDir.*separate/],
    [{ resourcePack: 'gameplay' }, /declaring resources/],
  ]) {
    project.config.bedrockCore.profiles.default.stages.guides = { compileScreens: false, ...settings };
    await writeFile(project.configPath, JSON.stringify(project.config));
    await assert.rejects(runBuild(optionsFor(project)), error);
  }
});

test('configuration validates guides settings through the nested schema', async (t) => {
  const project = await guidesFor(t);

  project.config.bedrockCore.profiles.default.stages.guides = { maxCodeLineBytes: 3 };
  assert.throws(() => validateConfig(project.config), /Invalid project configuration/);
  project.config.bedrockCore.profiles.default.stages.guides = { strictLocales: 'yes' };
  assert.throws(() => validateConfig(project.config), /Invalid project configuration/);
  project.config.bedrockCore.profiles.default.stages.guides = { sourceDir: 'content', compileScreens: false, pretty: { size: 2 } };
  validateConfig(project.config);
});
