import { put } from './project.js';

/** Minimal installed-runtime contract; engine behavior is tested by the runtime package. */
export async function installI18nRuntime(root) {
  await put(root, 'node_modules/@bedrock-core/i18n/package.json', JSON.stringify({
    name: '@bedrock-core/i18n', type: 'module', exports: { '.': { types: './index.ts', import: './index.ts' } },
  }));
  await put(root, 'node_modules/@bedrock-core/i18n/index.ts', `
    export interface I18nResourceExtensions {}
    interface Tree { readonly [key: string]: string | Tree }
    interface Engine<R> {
      locale: string;
      bundle: any;
      t<S extends string>(selector: (tree: R) => S, args?: Record<string, string | number>): string;
      key<S extends string>(selector: (tree: R) => S, args?: Record<string, string | number>): string;
      raw<S extends string>(selector: (tree: R) => S, args?: Record<string, string | number>): unknown;
      resolve(key: string): string | undefined;
      forLocale(locale: string): Engine<R>;
    }
    type Default<L> = 'en_US' extends keyof L ? 'en_US' : keyof L;
    export function createI18n<const L extends Record<string, Tree>, D extends keyof L = Default<L>>(
      locales: L, options?: { namespace?: string; defaultLocale?: D; asDefault?: boolean },
    ): Engine<Omit<L[D], keyof I18nResourceExtensions> & I18nResourceExtensions>;
    export function createI18n(input: any, _options: any = {}): Engine<any> {
      const bundle = input;
      const pointer = (path = ''): any => new Proxy({ path }, { get: (value, key) => key === '__path' ? value.path : pointer(path ? path + '.' + String(key) : String(key)) });
      const pathOf = (selector: any) => selector(pointer()).__path;
      const realKey = (path: string) => path.startsWith('vanilla.') ? path.slice(8) : bundle.libs.includes(path.split('.')[0]) ? path : bundle.namespace + '.' + path;
      const forLocale = (locale: string): Engine<any> => {
        const table = { ...bundle.locales[bundle.defaultLocale], ...bundle.locales[locale] };
        const template = (path: string) => table[path] ?? path;
        return {
          bundle, locale,
          t: (selector: any, args: any = {}) => template(pathOf(selector)).replace(/{{(.*?)}}/g, (_match: string, key: string) => String(args[key])),
          key: (selector: any, ..._args: any[]) => realKey(pathOf(selector)),
          raw: (selector: any, args: any = {}) => {
            const path = pathOf(selector);
            return { translate: realKey(path), with: (bundle.args[path] ?? []).map((key: string) => String(args[key])) };
          },
          resolve: (key: string) => {
            const path = key.startsWith(bundle.namespace + '.') ? key.slice(bundle.namespace.length + 1) : key;
            return table[path] ?? table['vanilla.' + key] ?? bundle.extra?.[locale]?.[key];
          },
          forLocale,
        };
      };
      return forLocale(bundle.defaultLocale);
    }
    export function overlay<const A extends object, const B extends object>(base: A, changes: B): Omit<A, keyof B> & B {
      return { ...base, ...changes };
    }
  `);
}
