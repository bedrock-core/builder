import { TEMPLATE_CATEGORY } from './category.ts';

/** Recursively JSON-serializable data. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Resolve a portable output basename for one tuple item and its index. */
export type TemplateName<T> = (item: T, index: number) => string | Promise<string>;
/** Produce JSON document data for one tuple item and its index. */
export type TemplateData<T, D = unknown> = (item: T, index: number) => D | Promise<D>;
/** Default-export tuple that generates one named document for each item. */
export type ManyTemplate<T, D = unknown> = readonly [TemplateName<T>, TemplateData<T, D>, readonly T[]];

function tag<T>(value: T, category: string): T {
  if (value !== null && typeof value === 'object') {
    Object.defineProperty(value, TEMPLATE_CATEGORY, { value: category, enumerable: false });
  }

  return value;
}

/**
 * Preserve the authored value while checking its JSON shape in TypeScript.
 * @param data Authored document returned unchanged.
 * @returns The same authored object, optionally tagged with a document category.
 */
export function defineTemplate<T extends object>(data: T): T;
export function defineTemplate<T extends object>(category: string, data: T): T;

export function defineTemplate<T extends object>(...args: [T] | [string, T]): T {
  if (args.length === 2) {
    return tag(args[1], args[0]);
  }

  return args[0];
}

/**
 * Generate one named JSON document per item, with typed async callbacks.
 * @param name Portable output-basename callback for each item.
 * @param data JSON document callback for each item.
 * @param items Items from which named documents are generated.
 * @returns A typed [name, data, items] tuple, optionally tagged with a document category.
 */
export function defineMany<T, D>(name: TemplateName<T>, data: TemplateData<T, D>, items: readonly T[]): ManyTemplate<T, D>;
export function defineMany<T, D>(category: string, name: TemplateName<T>, data: TemplateData<T, D>, items: readonly T[]): ManyTemplate<T, D>;

export function defineMany<T, D>(...args:
  [TemplateName<T>, TemplateData<T, D>, readonly T[]]
  | [string, TemplateName<T>, TemplateData<T, D>, readonly T[]]
): ManyTemplate<T, D> {
  if (args.length === 4) {
    const [category, name, data, items] = args;

    return tag([name, data, items] as const, category);
  }

  return args;
}
