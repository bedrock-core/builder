export const TEMPLATE_CATEGORY = Symbol.for('@bedrock-core/generator.category');

export function templateCategory(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') {
    return;
  }

  const category = (value as { [TEMPLATE_CATEGORY]?: unknown })[TEMPLATE_CATEGORY];

  return typeof category === 'string' ? category : undefined;
}
