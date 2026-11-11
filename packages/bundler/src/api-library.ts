import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectApiLibrary } from './api.ts';
import { apiShapeSource } from './api-source.ts';

/** Generate portable, checked wrappers for a library's per-Runtime API declarations. */
export async function emitApiLibrary(options: { root: string; entry: string; output: string }): Promise<{ output: string; receipt: string; inputs: string[] }> {
  const root = path.resolve(options.root);
  const entry = path.resolve(root, options.entry);
  const output = path.resolve(root, options.output);
  const relative = path.relative(root, output);

  if (!/\.[cm]?tsx?$/.test(output) || entry === output || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Generated API library output must be a separate file inside its package');
  }

  const inspected = inspectApiLibrary(root, entry);
  const names = new Set(Object.keys(inspected.factories));

  const identifier = (candidate: string): string => {
    while (names.has(candidate)) {
      candidate += '_';
    }

    names.add(candidate);

    return candidate;
  };

  const define = identifier('__defineApiDeclaration');
  const implementation = identifier('__implementation');

  const specifier = (file: string): string => {
    const name = path.relative(path.dirname(output), file).replaceAll('\\', '/').replace(/\.[cm]?tsx?$/, '');

    return name.startsWith('.') ? name : `./${name}`;
  };

  const lines = [
    '/* eslint-disable */',
    '// Generated from checked API declaration factories by @bedrock-core/builder-bundler.',
    `import { defineApiDeclaration as ${define} } from '@bedrock-core/server-runtime/api';`,
    `import * as ${implementation} from ${JSON.stringify(specifier(entry))};`,
    `export * from ${JSON.stringify(specifier(entry))};`,
  ];

  for (const [index, [name, factory]] of Object.entries(inspected.factories).entries()) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      throw new Error('API declaration factories need named identifier exports');
    }

    const shape = apiShapeSource(factory.shape, specifier, `apiValues${index}_`);

    lines.push(...shape.imports,
      `export function ${name}(...args: Parameters<typeof ${implementation}.${name}>): ReturnType<typeof ${implementation}.${name}> {`,
      `  return ${define}(${JSON.stringify(`${inspected.moduleName}#${name}:${factory.contract}`)}, ${shape.shape}, ${implementation}.${name}(...args));`,
      '}');
  }

  const text = `${lines.join('\n')}\n`;
  const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
  const inputs: { package: string; file: string; sha256: string }[] = [];
  const seen = new Set<string>();

  for (const file of inspected.inputs.sort()) {
    if (file === output || !/\.(?:[cm]?tsx?|json)$/.test(file) || !(await stat(file).catch(() => undefined))?.isFile()) {
      continue;
    }

    let directory = path.dirname(file);

    while (true) {
      const metadata: unknown = await readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined);

      if (metadata && typeof metadata === 'object' && 'name' in metadata && typeof metadata.name === 'string') {
        const name = path.relative(directory, file).replaceAll('\\', '/');
        const key = `${metadata.name}:${name}`;

        if (!seen.has(key)) {
          inputs.push({ package: metadata.name, file: name, sha256: hash(await readFile(file)) });
          seen.add(key);
        }

        break;
      }

      const parent = path.dirname(directory);

      if (parent === directory) {
        break;
      }

      directory = parent;
    }
  }

  const metadata: { name: string } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const receipt = output.replace(/\.[cm]?tsx?$/, '.json');

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, text);
  await writeFile(receipt, `${JSON.stringify({ formatVersion: '1.0.0', package: metadata.name, output: relative.replaceAll('\\', '/'), sha256: hash(text), inputs }, null, 2)}\n`);

  return { output, receipt, inputs: inspected.inputs };
}
