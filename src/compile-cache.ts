import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compilerVersion } from '../packages/bundler/src/index.ts';
import type { BuildContext } from './contract.d.ts';

interface Input {
  root: 'project' | 'generated';
  path: string;
}
interface Output {
  path: string;
  content: string;
  hash: string;
}
interface CachedBundle {
  inputs: Input[];
  files: Output[];
}
interface CacheRecord {
  fingerprint: string;
  bundles: Record<string, CachedBundle>;
}
interface Compilation {
  inputs: string[];
  files: string[];
}
export interface CompilationCache {
  readonly hit: boolean;
  restore(id: string): Promise<Compilation>;
  record(id: string, compilation: Compilation): Promise<void>;
  save(): Promise<void>;
}

function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function validRecord(value: unknown, fingerprint: string, entries: readonly string[], context: BuildContext): value is CacheRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as CacheRecord;

  if (record.fingerprint !== fingerprint || !record.bundles || typeof record.bundles !== 'object') {
    return false;
  }

  for (const id of entries) {
    const bundle = record.bundles[id];

    if (!bundle || !Array.isArray(bundle.files) || !bundle.files.length || !Array.isArray(bundle.inputs)) {
      return false;
    }

    for (const file of bundle.files) {
      if (!file || typeof file.path !== 'string' || !file.path.startsWith('bundler/')
        || !contains(context.generatedDir, path.resolve(context.generatedDir, file.path))
        || typeof file.content !== 'string' || digest(Buffer.from(file.content, 'base64')) !== file.hash) {
        return false;
      }
    }

    for (const input of bundle.inputs) {
      if (!input || !['project', 'generated'].includes(input.root) || typeof input.path !== 'string'
        || input.path.split('/').includes('node_modules')) {
        return false;
      }

      const root = input.root === 'project' ? context.stagedRoot : context.generatedDir;

      if (!contains(root, path.resolve(root, input.path))) {
        return false;
      }
    }
  }

  return true;
}

/** Cache local deterministic bundles; external dependencies and inherited compiler configs rebuild. */
export async function compilationCache(context: BuildContext, settings: Record<string, unknown>, entries: readonly string[]): Promise<CompilationCache | undefined> {
  if (!context.cache || !entries.length) {
    return undefined;
  }

  const hash = createHash('sha256');
  let cacheable = true;

  hash.update(JSON.stringify({ node: process.versions.node, compilerVersion, settings, entries, imports: context.generatedImports }));

  for (const file of ['./compile-cache.ts', './stages/bundler.ts', '../packages/bundler/src/index.ts']) {
    hash.update(await readFile(new URL(file, import.meta.url)));
  }

  const explicitConfig = typeof settings.tsconfig === 'string' ? path.resolve(context.stagedRoot, settings.tsconfig) : undefined;

  if (explicitConfig && !contains(context.stagedRoot, explicitConfig)) {
    return undefined;
  }

  async function snapshot(root: string, directory = root): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      context.signal?.throwIfAborted();
      const file = path.join(directory, entry.name);

      hash.update(`${path.relative(root, file).replaceAll('\\', '/')}\0`);

      if (entry.isSymbolicLink() || entry.name === 'node_modules') {
        cacheable = false;
        continue;
      }

      if (entry.isDirectory()) {
        hash.update('directory');
        await snapshot(root, file);
      } else if (entry.isFile()) {
        const content = await readFile(file);

        hash.update(digest(content));

        if (((entry.name.startsWith('tsconfig') && entry.name.endsWith('.json')) || file === explicitConfig)
          && /"extends"\s*:/.test(content.toString('utf8'))) {
          cacheable = false;
        }
      } else {
        cacheable = false;
      }
    }
  }

  hash.update('project');
  await snapshot(context.stagedRoot);
  hash.update('generated');
  await snapshot(context.generatedDir);

  if (!cacheable) {
    return undefined;
  }

  const fingerprint = hash.digest('hex');
  const directory = path.join(context.projectRoot, '.bedrock-core/cache/build/bundler');
  const file = path.join(directory, `${digest(context.profile)}.json`);
  let current = context.projectRoot;

  for (const segment of path.relative(context.projectRoot, directory).split(path.sep)) {
    current = path.join(current, segment);

    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return undefined;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  let cached: CacheRecord | undefined;

  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));

    if (validRecord(value, fingerprint, entries, context)) {
      cached = value;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      context.logger.warn?.(`@bedrock-core/builder: unable to read compilation cache: ${String(error)}`);
    }
  }

  const bundles: Record<string, CachedBundle> = Object.create(null);

  return {
    hit: cached !== undefined,
    async restore(id) {
      const bundle = cached!.bundles[id];
      const files: string[] = [];

      for (const output of bundle.files) {
        context.signal?.throwIfAborted();
        const destination = path.resolve(context.generatedDir, output.path);

        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.from(output.content, 'base64'));
        files.push(destination);
      }

      return {
        files,
        inputs: bundle.inputs.map(input => path.resolve(input.root === 'project' ? context.stagedRoot : context.generatedDir, input.path)),
      };
    },
    async record(id, compilation) {
      const inputs: Input[] = [];

      for (const input of compilation.inputs) {
        const root = contains(context.stagedRoot, input) ? 'project' : contains(context.generatedDir, input) ? 'generated' : undefined;

        if (!root || input.split(path.sep).includes('node_modules')) {
          cacheable = false;
          continue;
        }

        inputs.push({ root, path: path.relative(root === 'project' ? context.stagedRoot : context.generatedDir, input).replaceAll('\\', '/') });
      }

      const files: Output[] = [];

      for (const output of compilation.files) {
        const content = await readFile(output);

        files.push({ path: path.relative(context.generatedDir, output).replaceAll('\\', '/'), content: content.toString('base64'), hash: digest(content) });
      }

      bundles[id] = { inputs, files };
    },
    async save() {
      if (!cacheable || cached || !entries.every(id => Object.hasOwn(bundles, id))) {
        return;
      }

      const candidate = `${file}.${randomUUID()}.tmp`;

      try {
        context.signal?.throwIfAborted();
        await mkdir(directory, { recursive: true });
        await writeFile(candidate, JSON.stringify({ fingerprint, bundles }), { flag: 'wx' });
        await rename(candidate, file);
      } catch (error) {
        context.signal?.throwIfAborted();
        context.logger.warn?.(`@bedrock-core/builder: unable to save compilation cache: ${String(error)}`);
      } finally {
        await rm(candidate, { force: true });
      }
    },
  };
}
