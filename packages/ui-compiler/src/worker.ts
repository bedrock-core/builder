import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { ScreenData, UiEnvironment, UiLibrary, UiRequest } from './types.ts';

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
      const loaded = await import(pathToFileURL(request.module).href) as { default: unknown; parameters?: unknown };

      if (request.kind === 'list') {
        value = Object.keys(loaded.default ?? {}).sort();
      } else {
        const component = request.member ? (loaded.default as Record<string, unknown>)[request.member] : loaded.default;

        if (typeof component !== 'function') {
          throw new Error(`Screen ${request.name} must export a component`);
        }

        const spec = { name: request.name, namespace: request.namespace, testMetadata: request.testMetadata === true };
        const host = library.runtime.hostFor(library.runtime.buildScreenTree(component)).id;
        let compiled: ScreenData & { face?: unknown; entries?: unknown };

        if (host === 'experimental-ore-ui') {
          if (!library.compiler.compileExperimentalOreScreen) {
            throw new Error('The selected UI compiler does not support Experimental_OreUI.');
          }

          compiled = library.compiler.compileExperimentalOreScreen(component, spec);
        } else {
          compiled = host === 'chest' ? library.compiler.compileScreen(component, spec) : library.compiler.compileFormScreen(component, spec);
        }

        let parameters = loaded.parameters;

        if (request.member && parameters !== undefined) {
          if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)
            || Object.keys(parameters).some(name => !Object.hasOwn(loaded.default as object, name))) {
            throw new Error('A screen collection exports parameter contracts by screen name');
          }

          parameters = (parameters as Record<string, unknown>)[request.member];
        }

        if (parameters !== undefined) {
          const validate = library.ui.isScreenMetadata;

          if (typeof validate !== 'function' || !validate({ key: `${request.namespace}:${request.name}`, kind: 'custom', parameters })) {
            throw new Error(`Invalid screen parameter contract for ${request.name}`);
          }

          compiled.parameters = parameters;

          // Public parameters require the owning component to rebuild its values and handlers.
          if (Object.keys(parameters as object).length) {
            delete compiled.table;
          }
        }

        if (!compiled.host && host !== 'experimental-ore-ui') {
          compiled.kind = host === 'form-modal' ? 'modal' : 'action';
        }

        // Linking and registration consume emitted data, not the compiler's source trees.
        const portable = { ...compiled,
          ...(Array.isArray(compiled.entries) ? { entryCount: compiled.entries.length } : {}),
        };

        delete portable.entries;
        delete portable.face;

        value = JSON.parse(JSON.stringify(portable)) as unknown;
      }
    }

    port.postMessage({ value });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error : new Error(String(error)) });
  }
});
