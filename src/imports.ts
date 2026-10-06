import type { BuildContext } from './contract.d.ts';

/** Producers own default import names; configured mappings can override those defaults. */
export function generatedAliases(context: BuildContext, mappings: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...context.generatedImports, ...mappings }).map(([specifier, id]) => [specifier, context.artifact(id).path]),
  );
}
