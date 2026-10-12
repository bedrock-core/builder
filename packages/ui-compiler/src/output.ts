import { glob, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mergeHook, parseJsonc } from './hooks.ts';
import { mergeLang, writeComposedLang, type ComposedLang } from './lang.ts';
import { writeTestMetadata } from './metadata.ts';
import type { LinkedUi, ScreenEntry, UiSettings } from './types.ts';

export function jsonText(value: unknown, pretty: UiSettings['pretty']): string {
  if (!pretty) {
    return JSON.stringify(value);
  }

  const tab = pretty.indent === 'tab';
  const indent = (tab ? '\t' : ' ').repeat(pretty.size ?? (tab ? 1 : 2));

  return `${JSON.stringify(value, null, indent)}\n`;
}

async function optionalText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Write one linked screen set to a staged resource pack.
 * @param pack Resource-pack directory receiving generated files.
 * @param linked Complete linked screen data for the current build.
 * @param entries Current screen modules and selected exports.
 * @param namespace Project namespace used for generated content.
 * @param settings UI output formatting and optional metadata settings.
 * @returns Paths of generated resource UI, language and metadata outputs.
 */
export async function writeUiResource(pack: string, linked: LinkedUi, entries: ScreenEntry[], namespace: string, settings: UiSettings): Promise<string[]> {
  const files: string[] = [];
  const outputDir = `ui/core-ui/screens/${namespace}`;
  const faces: Record<string, unknown> = {};
  const lang: ComposedLang = {};

  const write = async (relative: string, value: unknown) => {
    const file = path.join(pack, relative);

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, jsonText(value, settings.pretty));
    files.push(file);
  };

  for (const screen of linked.screens) {
    await write(`${outputDir}/${screen.name}.json`, screen.document);
    mergeLang(lang, screen.lang);

    for (const [name, face] of Object.entries(screen.faces)) {
      if (faces[name] !== undefined && JSON.stringify(faces[name]) !== JSON.stringify(face)) {
        throw new Error(`UI face ${name} differs between screens`);
      }

      faces[name] = face;
    }
  }

  await write(`${outputDir}/faces.json`, { namespace: linked.screens[0]?.facesNamespace ?? `${namespace}_faces`, ...faces });

  for (const hook of linked.hooks) {
    await write(hook.file, mergeHook(await optionalText(path.join(pack, hook.file)), hook.document));
  }

  for (const document of linked.documents) {
    await write(document.file, document.document);
  }

  if (settings.stamp) {
    const hash = createHash('sha1');
    const sources: string[] = [];

    for await (const file of glob('ui/**/*.json', { cwd: pack })) {
      sources.push(file);
    }

    for (const file of sources.sort()) {
      hash.update(file.replaceAll('\\', '/')).update(await readFile(path.join(pack, file)));
    }

    const now = new Date();
    const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    await write(`${outputDir}/core_build.json`, {
      namespace: 'core_ui_build',
      stamp: {
        type: 'label', text: `ui ${hash.digest('hex').slice(0, 6)} ${clock}`, localize: false,
        font_size: 'small', color: [1, 1, 0], shadow: true, size: ['default', 'default'],
        anchor_from: 'top_left', anchor_to: 'top_left', offset: [2, 2], layer: 50,
      },
    });
    await write('ui/hud_screen.json', mergeHook(await optionalText(path.join(pack, 'ui/hud_screen.json')), {
      namespace: 'hud',
      root_panel: {
        modifications: [{ array_name: 'controls', operation: 'insert_back', value: [{ 'core_build_stamp@core_ui_build.stamp': {} }] }],
      },
    }));
  }

  const textsDir = path.join(pack, 'texts');

  if (Object.keys(lang).length) {
    await mkdir(textsDir, { recursive: true });
    writeComposedLang(textsDir, lang);

    for (const locale of Object.keys(lang)) {
      files.push(path.join(textsDir, `${locale}.lang`));
    }
  }

  if (linked.screens.some(screen => screen.hasText)) {
    await mkdir(textsDir, { recursive: true });
    let names = (await readdir(textsDir)).filter(name => name.endsWith('.lang'));

    if (!names.length) {
      names = ['en_US.lang'];
      await write('texts/languages.json', ['en_US']);
    }

    for (const name of names) {
      const file = path.join(textsDir, name);
      const existing = await optionalText(file) ?? '';

      if (!linked.lang[0] || !existing.includes(linked.lang[0])) {
        await writeFile(file, `${existing.trimEnd()}\n\n${linked.lang.join('\n')}\n`);
      }

      files.push(file);
    }
  }

  const uiDefs = path.join(pack, 'ui/_ui_defs.json');
  const existing = await optionalText(uiDefs);
  const definitions = existing ? parseJsonc(existing) : {};
  const names = definitions.ui_defs ?? [];

  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
    throw new Error('ui/_ui_defs.json must contain a ui_defs array of paths');
  }

  definitions.ui_defs = [...new Set([...names, ...files.filter(file => file.startsWith(path.join(pack, 'ui'))).map(file => path.relative(pack, file).replaceAll('\\', '/'))])];
  await write('ui/_ui_defs.json', definitions);
  writeTestMetadata(pack, linked.screens.map(screen => ({
    file: `${outputDir}/${screen.name}.json`,
    source: entries.find(entry => entry.name === screen.name)!.source,
    metadata: screen.testMetadata,
  })), settings.testMetadata === true);

  if (settings.testMetadata && linked.screens.length) {
    files.push(path.join(pack, 'bedrock-core/test-metadata.json'));
  }

  return [...new Set(files)];
}

/**
 * Runtime registrations retain source imports only for screens with live behavior.
 * @param linked Complete linked screen data for the current build.
 * @param entries Current screen modules and selected exports.
 * @param directory Directory containing the current pack manifest.
 * @param namespace Project namespace used for generated content.
 * @returns Runtime screen-registration module source; no file is written by this function.
 */
export function uiRegistration(linked: Pick<LinkedUi, 'screens'>, entries: ScreenEntry[], directory: string, namespace: string): string {
  const imports: string[] = [];
  const calls: string[] = [];
  const table: unknown[] = [];
  const keys: string[] = [];

  const reference = (name: string): string => {
    const entry = entries.find(entry => entry.name === name)!;
    const relative = path.isAbsolute(entry.source) ? path.relative(directory, entry.source).replaceAll('\\', '/') : entry.source;
    const source = path.isAbsolute(entry.source) && !relative.startsWith('.') ? `./${relative}` : relative;
    const alias = `Screen${imports.length}`;

    imports.push(`import ${alias} from ${JSON.stringify(source)};`);

    return entry.member ? `${alias}[${JSON.stringify(entry.member)}]` : alias;
  };

  for (const screen of linked.screens) {
    const key = `${namespace}:${screen.name}`;
    const parameters = screen.parameters ?? (screen.table ? {} : undefined);
    const descriptor = { key, kind: screen.host?.kind ?? screen.kind ?? 'action',
      ...parameters === undefined ? {} : { parameters } };

    keys.push(key);
    calls.push(`registerScreenDescriptor(${JSON.stringify(descriptor)});`);

    if (screen.host) {
      if (screen.looks?.length) {
        calls.push(`registerContainerLooks(${reference(screen.name)}, ${JSON.stringify(screen.looks)});`);
      }
    } else {
      if (screen.table) {
        table.push({ key, title: screen.title, values: screen.table.values, targets: screen.table.targets });
      } else {
        calls.push(`registerCompiledScreen(${reference(screen.name)}, ${JSON.stringify({ ...descriptor, title: screen.title, snapshot: screen.snapshot })});`);
      }
    }
  }

  return [
    `import { addonReference, registerCompiledScreen, registerContainerLooks, registerScreenDescriptor, registerStaticScreens } from '@bedrock-core/ui';`,
    ...imports,
    `export const UI_NAMESPACE = ${JSON.stringify(namespace)};`,
    `export const UI_REFERENCE = ${JSON.stringify(table)} as const;`,
    'registerStaticScreens(UI_REFERENCE);',
    ...calls,
    `export const SCREEN_KEYS = ${JSON.stringify(keys)} as const;`,
    'export type ScreenKey = typeof SCREEN_KEYS[number];',
    `export function uiReference() { return addonReference(UI_NAMESPACE); }`,
    '',
  ].join('\n');
}
