import { implementationFile } from './implementation.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleScripts, compilerVersion, type BundleOptions, type CompiledModule } from '@bedrock-core/builder-bundler';
import { buildCache } from './file-cache.ts';
import type { BuildContext } from './contract.d.ts';

const implementations = new WeakMap<BuildContext, Promise<string>>();

function implementationFor(context: BuildContext): Promise<string> {
  if (!implementations.has(context)) {
    implementations.set(context, (async () => {
      const version = createHash('sha256');

      for (const file of [import.meta.url, '@bedrock-core/builder-bundler', '@bedrock-core/builder-bundler/internal/dependencies']) {
        version.update(await readFile(implementationFile(file, import.meta.url)));
      }

      return version.digest('hex');
    })());
  }

  return implementations.get(context)!;
}

/** Reuse compiled Node modules while callers continue to evaluate their exports. */
export async function compileModule(context: BuildContext, options: BundleOptions): Promise<CompiledModule & { cached: boolean }> {
  const source = path.resolve(options.root, options.entry);
  const outfile = path.resolve(options.root, options.outfile);
  const relative = (file: string) => path.relative(context.stagedRoot, file);
  const compilation = await buildCache(context).reuse(`compiled:${relative(source).replaceAll('\\', '/')}`, {
    inputs: [source],
    key: {
      version: await implementationFor(context),
      compilerVersion,
      nodePath: process.env.NODE_PATH ?? '',
      output: path.basename(outfile),
      debug: options.debug ?? false,
      target: options.target ?? 'es2020',
      tsconfig: options.tsconfig ?? null,
      external: options.external ?? [],
      aliases: Object.fromEntries(Object.entries(options.aliases ?? {}).map(([name, file]) => [name, relative(path.resolve(options.root, file))])),
      platform: options.platform ?? 'neutral',
      banner: options.banner ?? null,
      inject: (options.inject ?? []).map(file => relative(path.resolve(options.root, file))),
    },
    async run() {
      const result = await bundleScripts(options);
      const files = [];

      for (const file of result.files) {
        const content = await readFile(file, 'utf8');
        const map = file.endsWith('.map') ? JSON.parse(content) as { sources: string[] } : undefined;

        files.push({
          name: path.basename(file),
          content,
          ...(map ? { sources: map.sources.map(source => relative(path.resolve(path.dirname(file), source))) } : {}),
        });
      }

      return {
        value: {
          files,
          sources: result.inputs.map(relative),
          watchFiles: result.watchFiles.map(relative),
          cacheable: result.cacheable,
        },
        inputs: [...result.inputs, ...result.watchFiles],
        cache: result.cacheable,
      };
    },
  });

  const files: string[] = [];

  for (const file of compilation.value.files) {
    context.signal?.throwIfAborted();
    const destination = path.join(path.dirname(outfile), file.name);
    let content = file.content;

    if (file.sources) {
      const map = JSON.parse(content) as { sources: string[] };

      map.sources = file.sources.map(source => path.relative(path.dirname(destination), path.resolve(context.stagedRoot, source)).replaceAll('\\', '/'));
      content = JSON.stringify(map);
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
    files.push(destination);
  }

  return {
    files,
    inputs: compilation.value.sources.map(file => path.resolve(context.stagedRoot, file)),
    watchFiles: compilation.value.watchFiles.map(file => path.resolve(context.stagedRoot, file)),
    cacheable: compilation.value.cacheable,
    cached: compilation.cached,
  };
}
