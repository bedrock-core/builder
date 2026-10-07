import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { UiEnvironment, UiLibrary, UiRequest } from './types.ts';

const environment = workerData as UiEnvironment;
const library = await import(pathToFileURL(environment.library).href) as UiLibrary;

if (environment.i18n) {
  library.i18n.createI18n(environment.i18n);
}

if (environment.locales) {
  library.runtime.setBuildLocales(environment.locales);
}

if (!parentPort) {
  throw new Error('UI compilation requires a worker port');
}

const port = parentPort;

port.on('message', async (request: UiRequest) => {
  try {
    let value: unknown;

    if (request.kind === 'exports') {
      value = Object.fromEntries(Object.entries(library).map(([name, exports]) => [name, Object.keys(exports)]));
    } else if (request.kind === 'link') {
      const screens = request.screens;
      const namespaces = new Set(screens.flatMap(screen => screen.host ? [screen.host.type.split(':')[0]] : []));

      value = {
        ...library.compiler.buildUiPack(screens, request.namespace),
        lang: library.runtime.charsetLang(),
        layoutProperty: library.runtime.LAYOUT_PROPERTY,
        maxLayout: library.runtime.MAX_LAYOUT,
        blockSlotLimit: library.runtime.BLOCK_SLOT_LIMIT,
        items: Object.fromEntries([...namespaces].map(namespace => [namespace, library.runtime.protocolItemDefinitions?.(namespace) ?? []])),
      };
    } else {
      const loaded = await import(pathToFileURL(request.module).href) as { default: unknown };

      if (request.kind === 'list') {
        value = Object.keys(loaded.default ?? {}).sort();
      } else {
        const component = request.member ? (loaded.default as Record<string, unknown>)[request.member] : loaded.default;

        if (typeof component !== 'function') {
          throw new Error(`Screen ${request.name} must export a component`);
        }

        const spec = { name: request.name, namespace: request.namespace, testMetadata: request.testMetadata === true };
        const chest = library.runtime.hostFor(library.runtime.buildScreenOnce(component)).id === 'chest';

        value = chest ? library.compiler.compileScreen(component, spec) : library.compiler.compileFormScreen(component, spec);
      }
    }

    port.postMessage({ value: JSON.stringify(value) });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error : new Error(String(error)) });
  }
});
