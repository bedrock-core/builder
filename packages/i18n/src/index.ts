import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bundleDtsText } from './dts.ts';
import { flattenNesting, templateVars, toPositional } from './interp.ts';
import { manifestAliasEntries, parseLang, stripGeneratedSection, upsertGeneratedSection } from './lang.ts';
import { discoverI18nLibs, localeFiles, LOCALE_FILE_RE } from './libs.ts';
import { loadResources } from './load.ts';
import { scanVanillaUsage, walkSources } from './scan.ts';
import { checkParity, checkPlurals, checkVarParity, flattenResources, pluralBase } from './tree.ts';
import { fetchVanillaLang, vanillaDtsText, VANILLA_LANG_URL_TEMPLATE } from './vanilla.ts';
import type { I18nOptions, I18nResult, JsonFormatting, TranslationBundle } from './types.ts';
export type { I18nOptions, I18nResult, I18nSettings, TranslationBundle, TranslationPack } from './types.ts';
export { parseLang } from './lang.ts';

type Table = Map<string, string>;

interface LibraryGroup {
  byLocale: Map<string, Table>;
  allPaths: Set<string>;
  typeRefs: string[];
  names: string[];
  defaultTable: Table;
}

const BEDROCK_LOCALES = new Set([
  'bg_BG', 'cs_CZ', 'da_DK', 'de_DE', 'el_GR', 'en_GB', 'en_US', 'es_ES', 'es_MX',
  'fi_FI', 'fr_CA', 'fr_FR', 'hu_HU', 'id_ID', 'it_IT', 'ja_JP', 'ko_KR', 'nb_NO',
  'nl_NL', 'pl_PL', 'pt_BR', 'pt_PT', 'ru_RU', 'sk_SK', 'sv_SE', 'tr_TR', 'uk_UA',
  'zh_CN', 'zh_TW',
]);

function jsonText(value: unknown, pretty?: JsonFormatting | false): string {
  const tab = pretty && pretty.indent === 'tab';
  const indent = pretty ? (tab ? '\t' : ' ').repeat(Math.max(1, Math.trunc(pretty.size ?? (tab ? 1 : 2)))) : undefined;

  return indent ? `${JSON.stringify(value, null, indent)}\n` : JSON.stringify(value);
}

function sorted(table: Table): Record<string, string> {
  return Object.fromEntries([...table.keys()].sort().map(key => [key, table.get(key)!]));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Compile trusted TS/JS resources independently of the builder and runtime translation library. */
export async function compileI18n(options: I18nOptions): Promise<I18nResult> {
  options.signal?.throwIfAborted();
  const root = path.resolve(options.root);
  const sourceDir = path.resolve(root, options.sourceDir ?? 'i18n');
  const outputDir = path.resolve(root, options.outputDir ?? '.bedrock-core/generated/i18n');
  const typesDir = path.resolve(root, options.typesDir ?? outputDir);
  const defaultLocale = options.defaultLocale ?? 'en_US';
  const namespace = options.namespace;
  const files = localeFiles(sourceDir);
  const inputs = new Set<string>([sourceDir]);
  const warnings: string[] = [];
  const errors: string[] = [];
  const pending = new Map<string, string>();
  const declarations: string[] = [];
  const result: I18nResult = { files: [], inputs: [], declarations, warnings };

  if (options.tsconfig) {
    inputs.add(path.resolve(root, options.tsconfig));
  }

  function warn(scope: string, text: string): void {
    const warning = `${scope}: ${text}`;

    warnings.push(warning);
    options.warn?.(warning);
  }

  function error(scope: string, text: string): void {
    errors.push(`${scope}: ${text}`);
  }

  function problem(scope: string, text: string): void {
    if (options.strict === false) {
      warn(scope, text);
    } else {
      error(scope, text);
    }
  }

  function assertValid(): void {
    options.signal?.throwIfAborted();

    if (errors.length) {
      throw new Error(`i18n compilation failed:\n${errors.join('\n')}`);
    }
  }

  if (fs.existsSync(sourceDir)) {
    for (const entry of fs.readdirSync(sourceDir)) {
      if (/\.d\.(?:ts|mts)$/.test(entry)) {
        continue;
      }

      if (/\.(?:ts|js|mts|mjs)$/.test(entry) && !LOCALE_FILE_RE.test(entry)) {
        problem(entry, 'expected a locale resource module named <xx_YY>.ts or <xx_YY>.js');
      }
    }
  }

  assertValid();

  if (!files.size) {
    return { ...result, inputs: [...inputs] };
  }

  if (!/^[a-z0-9_]+$/.test(namespace)) {
    error('namespace', 'must be lowercase a-z0-9_');
  }

  if (!files.has(defaultLocale)) {
    error('defaultLocale', `${defaultLocale} has no resource module; it must define the resource shape`);
  }

  for (const locale of files.keys()) {
    if (!BEDROCK_LOCALES.has(locale)) {
      problem(locale, 'not a locale code the Bedrock client ships');
    }
  }

  assertValid();
  const workspace = await mkdtemp(path.join(tmpdir(), 'bedrock-core-i18n-'));

  try {
    async function load(file: string, scope: string): Promise<Table> {
      try {
        const id = createHash('sha256').update(path.relative(root, file)).digest('hex');
        const value = await loadResources(file, path.join(workspace, `resource-${id}.mjs`), options, inputs);

        return flattenResources(value, { error: (key, text) => error(`${scope} ${key}`, text) });
      } catch (cause) {
        options.signal?.throwIfAborted();
        error(scope, message(cause));

        return new Map();
      }
    }

    const ownRaw = new Map<string, Table>();

    for (const [locale, file] of files) {
      ownRaw.set(locale, await load(file, locale));
    }

    const libs = discoverI18nLibs(options.dependencyRoot ?? root, inputs);
    const groups = new Map<string, LibraryGroup>();

    for (const lib of libs) {
      const resources = localeFiles(lib.dir);

      if (!resources.size) {
        warn(lib.name, `declares bedrockCore.i18n but ${lib.dir} has no locale modules`);
        continue;
      }

      let group = groups.get(lib.namespace);

      if (!group) {
        group = { byLocale: new Map(), allPaths: new Set(), typeRefs: [], names: [], defaultTable: new Map() };
        groups.set(lib.namespace, group);
      }

      group.names.push(lib.name);
      const typeLocale = resources.has(defaultLocale) ? defaultLocale : resources.has('en_US') ? 'en_US' : [...resources.keys()][0];

      group.typeRefs.push(`${lib.name}/i18n/${typeLocale}`);

      for (const [locale, file] of resources) {
        const flat = await load(file, `${lib.name} ${locale}`);
        const table = group.byLocale.get(locale) ?? new Map();

        group.byLocale.set(locale, table);

        for (const [key, value] of flat) {
          if (table.has(key) && table.get(key) !== value) {
            error(`${lib.namespace}.${key}`, `defined with different values by ${group.names.join(', ')}`);
            continue;
          }

          table.set(key, value);
          group.allPaths.add(key);
        }
      }
    }

    for (const group of groups.values()) {
      group.defaultTable = group.byLocale.get(defaultLocale) ?? group.byLocale.get('en_US') ?? group.byLocale.get([...group.byLocale.keys()].sort()[0]) ?? new Map();
    }

    const own = new Map<string, Table>();
    const overrides = new Map<string, Table>();
    const vanillaOverrides = new Map<string, Table>();

    for (const [locale, raw] of ownRaw) {
      const roots: Table = new Map();
      const replacements: Table = new Map();
      const vanilla: Table = new Map();

      for (const [key, value] of raw) {
        const branch = key.split('.')[0];
        const group = groups.get(branch);

        if (branch === 'vanilla') {
          vanilla.set(key.slice('vanilla.'.length), value);
        } else if (group) {
          if (group.allPaths.has(key.slice(branch.length + 1))) {
            replacements.set(key, value);
          } else {
            problem(`${locale} ${key}`, 'library override must target an existing key');
          }
        } else {
          roots.set(key, value);
        }
      }

      own.set(locale, roots);
      overrides.set(locale, replacements);
      vanillaOverrides.set(locale, vanilla);
    }

    const ownDefault = own.get(defaultLocale)!;

    for (const [locale, table] of own) {
      if (locale === defaultLocale) {
        continue;
      }

      const { missing, extra } = checkParity(ownDefault, table);

      if (missing.length) {
        problem(locale, `keys missing (filled from ${defaultLocale}): ${missing.join(', ')}`);
      }

      if (extra.length) {
        problem(locale, `keys have no ${defaultLocale} counterpart and were dropped: ${extra.join(', ')}`);
      }

      for (const drift of checkVarParity(ownDefault, table)) {
        problem(`${locale} ${drift.path}`, `interpolation variables must match ${defaultLocale}: expected {${drift.expected.join(', ')}}, got {${drift.got.join(', ')}}`);
      }
    }

    for (const [locale, table] of overrides) {
      for (const [key, value] of table) {
        const branch = key.split('.')[0];
        const reference = groups.get(branch)!.defaultTable.get(key.slice(branch.length + 1));

        if (reference !== undefined && templateVars(reference).sort().join('\0') !== templateVars(value).sort().join('\0')) {
          problem(`${locale} ${key}`, 'override must keep the library interpolation variables');
        }
      }
    }

    const combinedDefault = new Map(ownDefault);

    for (const [branch, group] of groups) {
      for (const [key, value] of group.defaultTable) {
        combinedDefault.set(`${branch}.${key}`, value);
      }
    }

    for (const base of checkPlurals(combinedDefault)) {
      problem(base, 'plural group requires its _other form');
    }

    const packs = (options.packs ?? []).map(pack => ({ ...pack, path: path.resolve(root, pack.path) }));
    const vanillaTables = new Map<string, Table>();
    let vanillaKeys = new Set<string>();

    if (options.vanilla) {
      const fetchOptions = {
        urlTemplate: options.vanillaLangUrlTemplate ?? VANILLA_LANG_URL_TEMPLATE,
        cacheDir: path.resolve(root, options.cacheDir ?? '.bedrock-core/cache/i18n'),
        maxAgeHours: options.cacheMaxAgeHours ?? 24,
        log: () => {},
        signal: options.signal,
      };
      const vanillaDefault = await fetchVanillaLang(defaultLocale, fetchOptions);

      vanillaKeys = new Set(Object.keys(vanillaDefault));
      const sources = [
        ...packs.filter(pack => pack.kind === 'behavior').flatMap(pack => walkSources(path.join(pack.path, 'scripts'))),
        ...libs.flatMap(lib => walkSources(path.join(lib.pkgDir, 'src'))),
      ];

      for (const source of sources) {
        inputs.add(source.path);
      }

      const used = [...scanVanillaUsage(sources, vanillaKeys)].sort();

      for (const locale of files.keys()) {
        let table = vanillaDefault;

        if (locale !== defaultLocale) {
          try {
            table = await fetchVanillaLang(locale, fetchOptions);
          } catch (cause) {
            options.signal?.throwIfAborted();
            warn(locale, `${message(cause)}; falling back to ${defaultLocale} vanilla strings`);
          }
        }

        vanillaTables.set(locale, new Map(used.map(key => [`vanilla.${key}`, table[key] ?? vanillaDefault[key] ?? key])));

        for (const key of vanillaOverrides.get(locale)!.keys()) {
          if (!vanillaKeys.has(key)) {
            problem(`${locale} vanilla.${key}`, 'vanilla override must target an existing key');
          }
        }
      }
    }

    const tables = new Map<string, Table>();

    for (const locale of files.keys()) {
      const combined: Table = new Map();

      for (const [branch, group] of groups) {
        const translated = group.byLocale.get(locale) ?? group.defaultTable;

        for (const [key, value] of group.defaultTable) {
          combined.set(`${branch}.${key}`, translated.get(key) ?? value);
        }

        for (const [key, value] of translated) {
          combined.set(`${branch}.${key}`, value);
        }
      }

      for (const [key, value] of overrides.get(locale)!) {
        combined.set(key, value);
      }

      const localeOwn = own.get(locale)!;

      for (const [key, value] of ownDefault) {
        combined.set(key, localeOwn.get(key) ?? value);
      }

      for (const [key, value] of localeOwn) {
        const base = pluralBase(key);

        if (!combined.has(key) && base !== undefined && ownDefault.has(`${base}_other`)) {
          combined.set(key, value);
        }
      }

      const flat: Table = new Map();

      for (const [key, value] of combined) {
        flat.set(key, flattenNesting(value, reference => combined.get(reference), text => problem(`${locale} ${key}`, text)));
      }

      tables.set(locale, flat);
    }

    const args: Record<string, string[]> = Object.create(null);

    for (const locale of [defaultLocale, ...files.keys()]) {
      for (const [key, value] of tables.get(locale)!) {
        const variables = templateVars(value);

        if (!Object.hasOwn(args, key) && variables.length) {
          args[key] = variables;
        }
      }
    }

    const bundle: TranslationBundle = {
      namespace,
      defaultLocale,
      libs: [...groups.keys()].sort(),
      args: Object.fromEntries(Object.keys(args).sort().map(key => [key, args[key]])),
      extra: {},
      locales: {},
    };

    // Resource packs precede behavior packs when collecting existing .lang entries.
    const extraPacks = [...packs.filter(pack => pack.kind === 'resource'), ...packs.filter(pack => pack.kind === 'behavior')];

    function read(file: string): string {
      inputs.add(file);

      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }

    const languagePacks = new Set<string>();

    for (const locale of files.keys()) {
      const extra: Table = new Map();

      for (const pack of extraPacks) {
        for (const [key, value] of Object.entries(parseLang(stripGeneratedSection(read(path.join(pack.path, 'texts', `${locale}.lang`)))))) {
          extra.set(key, value);
        }
      }

      if (extra.size) {
        bundle.extra[locale] = sorted(extra);
      }

      const entries: Table = new Map();

      for (const [key, value] of tables.get(locale)!) {
        const realKey = groups.has(key.split('.')[0]) ? key : `${namespace}.${key}`;

        try {
          entries.set(realKey, toPositional(value, args[key] ?? []));
        } catch (cause) {
          error(`${locale} ${key}`, message(cause));
        }
      }

      const aliases = manifestAliasEntries(entries, namespace);

      for (const pack of packs) {
        const file = path.join(pack.path, 'texts', `${locale}.lang`);
        const existing = read(file);

        if (pack.kind === 'resource' || aliases.size) {
          const generated = pack.kind === 'resource' ? new Map([...entries, ...vanillaOverrides.get(locale)!, ...aliases]) : aliases;

          pending.set(file, upsertGeneratedSection(existing, generated));
          languagePacks.add(pack.path);
        } else if (fs.existsSync(file) && stripGeneratedSection(existing) !== existing) {
          pending.set(file, stripGeneratedSection(existing));
        }
      }

      const runtimeTable = new Map([...tables.get(locale)!, ...(vanillaTables.get(locale) ?? [])]);

      for (const [key, value] of vanillaOverrides.get(locale)!) {
        if (runtimeTable.has(`vanilla.${key}`)) {
          runtimeTable.set(`vanilla.${key}`, value);
        }
      }

      bundle.locales[locale] = sorted(runtimeTable);
    }

    for (const directory of languagePacks) {
      const file = path.join(directory, 'texts', 'languages.json');
      const content = read(file);
      let existing: string[] = [];

      if (content) {
        try {
          const parsed: unknown = JSON.parse(content);

          if (!Array.isArray(parsed) || parsed.some(locale => typeof locale !== 'string')) {
            throw new Error('expected an array of locale codes');
          }

          existing = parsed;
        } catch (cause) {
          warn(file, `invalid language catalogue; rewriting it: ${message(cause)}`);
        }
      }

      pending.set(file, jsonText([...new Set([...existing, ...files.keys()])], options.pretty));
    }

    const bundlePath = path.join(outputDir, 'i18n.generated.json');

    pending.set(bundlePath, jsonText(bundle, options.pretty));

    if (options.types !== false) {
      const authoredFile = path.join(options.declarationRoot ?? root, path.relative(root, files.get(defaultLocale)!));
      const relative = path.relative(typesDir, authoredFile).replaceAll('\\', '/');
      const declarationFile = path.join(typesDir, 'i18n.generated.d.ts');

      pending.set(declarationFile, bundleDtsText({
        defaultLocale,
        ownModule: relative.startsWith('.') ? relative : `./${relative}`,
        vanilla: options.vanilla ?? false,
        libs: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([branch, group]) => ({ namespace: branch, typeRefs: group.typeRefs.sort() })),
      }));
      declarations.push(declarationFile);

      if (options.vanilla) {
        const vanillaFile = path.join(typesDir, 'vanilla.generated.d.ts');

        pending.set(vanillaFile, vanillaDtsText(vanillaKeys));
        declarations.push(vanillaFile);
      }
    }

    // Validation and positional conversion finish before any pack or declaration is changed.
    assertValid();

    for (const [file, content] of pending) {
      options.signal?.throwIfAborted();

      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
      }
    }

    return { ...result, bundle, bundlePath, files: [...pending.keys()].filter(file => !declarations.includes(file)), inputs: [...inputs] };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
