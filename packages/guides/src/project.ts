import fs from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { assembleLocale, buildManifest, compileGuidePage, type Report } from './build.ts';
import { keyPrefix } from './keys.ts';
import { inlineLinkedText, linksByKey } from './linked.ts';
import { reconcileLocale, summarizeKeysByPage } from './locales.ts';
import { upsertGeneratedSection } from './lang.ts';
import { readPngSize } from './png.ts';
import { guideScreenModules, guideScreenTables, SCREEN_HEADER } from './screens.ts';
import type { GuideDiagnostic, GuideManifest, GuidePageCompilation, GuidesSettings } from './types.ts';

/** Project paths, locale packs and diagnostics for compiling MDX guides. */
export interface GuidesOptions extends GuidesSettings {
  /** Project working directory. */
  root: string;
  /** Required guide-key namespace. */
  namespace: string;
  /** Pack destinations for language files and resource assets. */
  packs?: { path: string; kind: 'resource' | 'behavior' }[];
  /** Generated output directory; defaults to .bedrock-core/generated/guides. */
  outputDir?: string;
  /** Editor-declaration directory; defaults to outputDir. */
  typesDir?: string;
  /** Generated import declared for editors; defaults to @bedrock-core/generated/guides. */
  moduleName?: string;
  /** Language-section owner; distinct owners preserve each other's contributions, and conflicting key values fail. */
  section?: string;
  /** Cooperative compilation cancellation. */
  signal?: AbortSignal;
  /** Nonfatal diagnostic sink. */
  warn?: (message: string) => void;
}

/** Guide manifest, written outputs, diagnostics and page reuse counts. */
export interface GuidesResult {
  /** Compiled runtime guide data when content exists. */
  manifest?: GuideManifest;
  /** Written runtime manifest path. */
  manifestPath?: string;
  /** Written manifest, language, asset and screen outputs. */
  files: string[];
  /** Observed guide sources and assets. */
  inputs: string[];
  /** Written editor declarations. */
  declarations: string[];
  /** Scoped compilation warnings and errors. */
  diagnostics: GuideDiagnostic[];
  /** Number of compiled locale pages. */
  pages: number;
  /** Number of locale pages reused by the runner. */
  reused: number;
}

interface PageOutput {
  value: GuidePageCompilation;
  inputs: string[];
  cached?: boolean;
}

/** The runner supplies this internally to reuse page compilations. */
export type PageReuse = (file: string, compile: () => PageOutput) => Promise<PageOutput>;

export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function jsonText(value: unknown, pretty?: GuidesSettings['pretty']): string {
  const tab = pretty && pretty.indent === 'tab';
  const indent = pretty ? (tab ? '\t' : ' ').repeat(Math.max(1, Math.trunc(pretty.size ?? (tab ? 1 : 2)))) : undefined;

  return indent ? `${JSON.stringify(value, null, indent)}\n` : JSON.stringify(value);
}

async function text(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

async function entries(directory: string) {
  try {
    const found = await readdir(directory, { withFileTypes: true });

    if (found.some(entry => entry.isSymbolicLink())) {
      throw new Error(`Guide sources cannot contain symlinks: ${directory}`);
    }

    return found.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

/** Compile content and validate the complete guide before writing any output. */
export async function compileProject(options: GuidesOptions, reuse?: PageReuse): Promise<GuidesResult> {
  const root = path.resolve(options.root);
  const sourceDir = path.resolve(root, options.sourceDir ?? 'guides');
  const outputDir = path.resolve(root, options.outputDir ?? '.bedrock-core/generated/guides');
  const typesDir = path.resolve(root, options.typesDir ?? outputDir);
  const defaultLocale = options.defaultLocale ?? 'en_US';
  const prefix = keyPrefix(options.namespace);
  const maxCodeLineBytes = options.maxCodeLineBytes ?? 60;
  const inputs = new Set<string>([sourceDir]);
  const diagnostics: GuideDiagnostic[] = [];
  const result: GuidesResult = { files: [], inputs: [], declarations: [], diagnostics, pages: 0, reused: 0 };
  const pending = new Map<string, string>();
  const obsolete: string[] = [];
  const packs = (options.packs ?? []).map(pack => ({ ...pack, path: path.resolve(root, pack.path) }));
  const resources = packs.filter(pack => pack.kind === 'resource');
  const included = picomatch(options.include ?? ['**/*.md', '**/*.mdx']);
  const excluded = picomatch(options.exclude ?? []);

  if (!inside(root, sourceDir)) {
    throw new Error('guides sourceDir must be a directory inside the project');
  }

  if (!Number.isInteger(maxCodeLineBytes) || maxCodeLineBytes < 4 || maxCodeLineBytes > 80) {
    throw new Error('maxCodeLineBytes must be an integer between 4 and 80');
  }

  function report(locale: string): Report {
    function add(level: GuideDiagnostic['level'], scope: string, message: string): void {
      diagnostics.push({ level, scope: `${locale} ${scope}`, message });

      if (level === 'warning') {
        options.warn?.(`${locale} ${scope}: ${message}`);
      }
    }

    return { warn: (scope, message) => add('warning', scope, message), error: (scope, message) => add('error', scope, message) };
  }

  function assertValid(): void {
    options.signal?.throwIfAborted();
    const errors = diagnostics.filter(diagnostic => diagnostic.level === 'error');

    if (errors.length) {
      throw new Error(`Guides compilation failed:\n${errors.map(error => `${error.scope}: ${error.message}`).join('\n')}`);
    }
  }

  const locales = (await entries(sourceDir)).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

  if (!locales.length) {
    return { ...result, inputs: [...inputs] };
  }

  if (!locales.includes(defaultLocale)) {
    throw new Error(`Guides default locale "${defaultLocale}" not found under ${sourceDir}`);
  }

  const directories = new Map<string, { files: Map<string, string>; categories: Map<string, Record<string, unknown>> }>();

  for (const locale of locales) {
    const files = new Map<string, string>();
    const categories = new Map<string, Record<string, unknown>>();

    async function walk(directory: string, relative = ''): Promise<void> {
      options.signal?.throwIfAborted();
      inputs.add(directory);

      for (const entry of await entries(directory)) {
        const file = path.join(directory, entry.name);
        const name = relative ? `${relative}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          await walk(file, name);
        } else if (entry.name === '_category_.json') {
          inputs.add(file);

          try {
            const value: unknown = JSON.parse(await readFile(file, 'utf8'));

            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              throw new Error('expected an object');
            }

            categories.set(relative, value as Record<string, unknown>);
          } catch (error) {
            report(locale).error(name, `invalid _category_.json: ${String(error)}`);
          }
        } else if (/\.mdx?$/i.test(name) && included(name) && !excluded(name)) {
          const id = name.replace(/\.mdx?$/i, '');

          if (files.has(id)) {
            report(locale).error(id, 'more than one source defines this page');
          }

          files.set(id, file);
        }
      }
    }

    await walk(path.join(sourceDir, locale));
    directories.set(locale, { files, categories });
  }

  assertValid();

  if (!directories.get(defaultLocale)!.files.size) {
    return { ...result, inputs: [...inputs] };
  }

  if (!/^[a-z0-9_]+$/.test(options.namespace)) {
    throw new Error('Guides namespace must contain lowercase a-z, 0-9 and underscores');
  }

  if (!resources.length) {
    throw new Error('Guide content requires a configured resource pack for its localized text');
  }

  const builds = new Map<string, ReturnType<typeof assembleLocale>>();
  const targets = new Set(directories.get(defaultLocale)!.files.keys());

  for (const locale of [defaultLocale, ...locales.filter(locale => locale !== defaultLocale)]) {
    const directory = directories.get(locale)!;
    const compiled = new Map<string, GuidePageCompilation>();

    for (const [pageId, file] of [...directory.files].sort(([a], [b]) => a < b ? -1 : 1)) {
      options.signal?.throwIfAborted();
      inputs.add(file);

      try {
        const compile = (): PageOutput => {
          const pageInputs = new Set([file]);
          const value = compileGuidePage({
            source: fs.readFileSync(file, 'utf8'),
            pageId,
            prefix,
            maxCodeLineBytes,
            imageSize(src) {
              for (const pack of resources) {
                const texture = path.resolve(pack.path, `${src}.png`);

                if (!inside(pack.path, texture)) {
                  throw new Error(`Guide texture must be inside its resource pack: ${src}`);
                }

                pageInputs.add(texture);

                if (fs.existsSync(texture)) {
                  const size = readPngSize(fs.readFileSync(texture));

                  if (size) {
                    return size;
                  }
                }
              }

              return undefined;
            },
          });

          return { value, inputs: [...pageInputs] };
        };

        const output = reuse ? await reuse(file, compile) : compile();

        output.inputs.forEach(input => inputs.add(input));
        result.pages++;
        result.reused += Number(output.cached === true);
        compiled.set(pageId, output.value);
      } catch (error) {
        options.signal?.throwIfAborted();
        report(locale).error(pageId, `parse error: ${String(error)}`);
      }
    }

    builds.set(locale, assembleLocale(compiled, directory.categories, prefix, report(locale), targets));
  }

  const build = builds.get(defaultLocale)!;
  const manifest = buildManifest({
    build,
    categories: directories.get(defaultLocale)!.categories,
    prefix,
    ns: options.namespace,
    defaultLocale,
    locales,
    report: report(defaultLocale),
  });
  const localeLang = new Map([[defaultLocale, build.lang]]);
  const localeLinks = new Map([[defaultLocale, linksByKey(build.pages)]]);

  for (const locale of locales.filter(locale => locale !== defaultLocale)) {
    const translated = builds.get(locale)!;
    const { filled, missing, extra } = reconcileLocale(build.lang, translated.lang);

    const gaps = [
      [missing, `untranslated keys filled from ${defaultLocale}`],
      [extra, `keys have no ${defaultLocale} counterpart and were dropped`],
    ] as const;

    for (const [keys, message] of gaps) {
      if (keys.length) {
        const details = `${keys.length} ${message}: ${summarizeKeysByPage(keys, prefix).join(', ')}`;

        report(locale)[options.strictLocales ? 'error' : 'warn']('parity', details);
      }
    }

    localeLang.set(locale, filled);
    localeLinks.set(locale, linksByKey(translated.pages));
  }

  assertValid();
  const manifestPath = options.manifestPath ? path.resolve(root, options.manifestPath) : path.join(outputDir, 'guides.generated.json');
  const screenInput = {
    pageIds: Object.keys(manifest.pages),
    gated: manifest.gated === true,
    gatedPageIds: Object.keys(manifest.pages).filter(id => manifest.pages[id].a !== undefined),
  };

  if (options.manifestPath && !inside(root, manifestPath)) {
    throw new Error('guides manifestPath must be inside the project');
  }

  if (options.compileScreens !== false) {
    const behavior = packs.find(pack => pack.kind === 'behavior');

    if (!behavior) {
      throw new Error('Compiled guide screens require a behavior pack; compileScreens: false emits content only');
    }

    const screensDir = path.resolve(root, options.screensDir ?? path.join(behavior.path, 'scripts/guides'));

    if (!packs.some(pack => pack.kind === 'behavior' && inside(path.join(pack.path, 'scripts'), screensDir))) {
      throw new Error('guides screensDir must be inside a configured behavior pack scripts directory');
    }

    const components = options.componentsModule ? path.resolve(root, options.componentsModule) : undefined;

    if (components && !inside(root, components)) {
      throw new Error('guides componentsModule must be inside the project');
    }

    Object.assign(manifest, guideScreenTables(screenInput));

    for (const module of guideScreenModules({ ...screenInput, screensDir, manifestPath, title: options.screenTitle ?? 'Guide', components })) {
      if (fs.existsSync(module.file) && !(await text(module.file)).startsWith(SCREEN_HEADER)) {
        throw new Error(`Generated guide screen would overwrite an existing file: ${module.file}`);
      }

      pending.set(module.file, module.source);
    }

    for (const entry of await entries(screensDir)) {
      const file = path.join(screensDir, entry.name);

      if (entry.isFile() && entry.name.endsWith('.screen.tsx') && !pending.has(file) && (await text(file)).startsWith(SCREEN_HEADER)) {
        obsolete.push(file);
      }
    }
  }

  inlineLinkedText(manifest.pages, localeLang, localeLinks, defaultLocale);
  pending.set(manifestPath, jsonText(manifest, options.pretty));

  for (const pack of resources) {
    for (const [locale, values] of localeLang) {
      const file = path.join(pack.path, 'texts', `${locale}.lang`);

      pending.set(file, upsertGeneratedSection(await text(file), values, options.section));
    }

    const file = path.join(pack.path, 'texts/languages.json');
    const content = await text(file);
    let existing: string[] = [];

    if (content) {
      try {
        const value: unknown = JSON.parse(content);

        if (!Array.isArray(value) || value.some(locale => typeof locale !== 'string')) {
          throw new Error('expected an array of locale codes');
        }

        existing = value;
      } catch (error) {
        report(defaultLocale).warn('languages.json', `invalid language catalogue; rewriting it: ${String(error)}`);
      }
    }

    pending.set(file, jsonText([...new Set([...existing, ...locales])], options.pretty));
  }

  const declaration = path.join(typesDir, 'guides.generated.d.ts');

  pending.set(declaration, [
    '// Generated by @bedrock-core. Include this file in your TypeScript project.',
    `declare module ${JSON.stringify(options.moduleName ?? '@bedrock-core/generated/guides')} {`,
    '  const manifest: import(\'@bedrock-core/builder-guides/types\').GuideManifest;',
    '  export default manifest;',
    '}', '',
  ].join('\n'));
  result.declarations.push(declaration);

  for (const [file, content] of pending) {
    options.signal?.throwIfAborted();

    if (content !== await text(file)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  }

  for (const file of obsolete) {
    await rm(file);
  }

  return {
    ...result,
    manifest: manifest as GuideManifest,
    manifestPath,
    inputs: [...inputs],
    files: [...pending.keys()].filter(file => file !== declaration),
  };
}
