import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFiles, resolveFeaturePacks, type BuildContext, type BuildDetection, type BuildStepResult } from '@bedrock-core/builder-plugin';
import type { GuidesSettings } from './index.ts';
import { compileProject, inside } from './project.ts';
export type { GuidesSettings } from './index.ts';

async function implementation(): Promise<string> {
  const directory = fileURLToPath(new URL('./', import.meta.url));
  const hash = createHash('sha256');

  for (const file of (await readdir(directory)).filter(file => /\.(?:ts|js)$/.test(file)).sort()) {
    hash.update(await readFile(path.join(directory, file)));
  }

  const packageFile = new URL('../package.json', import.meta.url);
  const metadata = await readFile(packageFile, 'utf8');
  const pkg = JSON.parse(metadata) as { dependencies: Record<string, string> };
  const require = createRequire(packageFile);
  const seen = new Set<string>();

  hash.update(metadata);

  async function dependency(name: string, resolver: NodeJS.Require): Promise<void> {
    // Declaration packages do not execute in the Markdown pipeline.
    if (name.startsWith('@types/')) {
      return;
    }

    const entry = resolver.resolve(name);

    if (seen.has(entry)) {
      return;
    }

    seen.add(entry);
    let directory = path.dirname(entry);

    hash.update(await readFile(entry));

    while (true) {
      try {
        const content = await readFile(path.join(directory, 'package.json'), 'utf8');

        const metadata = JSON.parse(content) as { name?: string; dependencies?: Record<string, string> };

        if (metadata.name === name) {
          hash.update(content);
          const nested = createRequire(path.join(directory, 'package.json'));

          for (const child of Object.keys(metadata.dependencies ?? {}).sort()) {
            await dependency(child, nested);
          }

          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      const parent = path.dirname(directory);

      if (parent === directory) {
        throw new Error(`Cannot identify the installed guide compiler dependency: ${name}`);
      }

      directory = parent;
    }
  }

  for (const name of Object.keys(pkg.dependencies).sort()) {
    await dependency(name, require);
  }

  return hash.digest('hex');
}

/** Compile staged guides, then hand their artifacts to i18n, UI and script bundling. */
export async function run(context: BuildContext, settings: GuidesSettings): Promise<BuildStepResult> {
  const packs: { path: string; kind: 'behavior' | 'resource' }[] = [];

  const routed = await resolveFeaturePacks(context, settings);

  for (const pack of routed) {
    if (pack.kind !== 'other') {
      packs.push({ path: pack.path, kind: pack.kind });
    }
  }

  const namespace = settings.namespace ?? context.namespace;
  const version = await implementation();
  const result = await compileProject({
    ...settings,
    root: context.stagedRoot,
    namespace,
    packs,
    outputDir: path.join(context.generatedDir, 'guides'),
    typesDir: path.join(context.projectRoot, '.bedrock-core/generated/guides'),
    signal: context.signal,
    warn: message => context.logger.warn?.(`@bedrock-core/builder: guides ${message}`),
  }, async (file, compile) => {
    const relative = path.relative(context.stagedRoot, file).replaceAll('\\', '/');
    const cached = await context.reuse(`page:${relative}`, {
      inputs: [file],
      key: {
        version,
        namespace,
        maxCodeLineBytes: settings.maxCodeLineBytes ?? 60,
        resources: packs
          .filter(pack => pack.kind === 'resource')
          .map(pack => path.relative(context.stagedRoot, pack.path)),
      },
      run: compile,
    });

    return { value: cached.value, inputs: cached.inputs, cached: cached.cached };
  });

  for (const file of result.inputs) {
    if (inside(context.stagedRoot, file)) {
      context.registerDependency(path.join(context.projectRoot, path.relative(context.stagedRoot, file)));
    }
  }

  if (result.manifestPath) {
    await context.registerArtifact('guides:manifest', result.manifestPath, { importAs: '@bedrock-core/generated/guides' });
  }

  for (const file of result.files.filter(file => file !== result.manifestPath)) {
    const pack = routed.map(pack => [pack.id, pack.path] as const).find(([, directory]) => inside(directory, file));

    if (pack) {
      await context.registerArtifact(`guides:${pack[0]}:${path.relative(pack[1], file).replaceAll('\\', '/')}`, file);
    }
  }

  return { cached: result.pages === result.reused, reason: `${result.pages - result.reused} pages compiled, ${result.reused} reused` };
}

/** Detect guide content without loading MDX modules. */
export async function detect(context: BuildContext, settings: GuidesSettings = {}): Promise<BuildDetection> {
  const source = path.resolve(context.stagedRoot, settings.sourceDir ?? 'guides');
  const needed = await hasFiles(source, settings.include ?? ['**/*.md', '**/*.mdx'], settings.exclude);

  return { needed, reason: `${needed ? 'Found' : 'No'} guide pages under ${path.relative(context.stagedRoot, source)}/` };
}
