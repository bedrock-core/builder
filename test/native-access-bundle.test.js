import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectFor } from '../test-support/project.js';
import { bundleScripts } from '../packages/bundler/src/index.ts';

async function put(root, file, contents) {
  const name = path.join(root, file);

  await mkdir(path.dirname(name), { recursive: true });
  await writeFile(name, typeof contents === 'string' ? contents : JSON.stringify(contents));

  return name;
}

const source = `import type {Entity} from '@minecraft/server';
  export function slot(entity:Entity,index:number) { return entity.getComponent('minecraft:inventory')!.container.getSlot(index); }
`;

test('staged native tracing resolves parent-installed SDK types from the authored dependency root', async (t) => {
  const authored = await projectFor(t);
  const staged = await projectFor(t);

  await put(authored.root, 'node_modules/@minecraft/server/package.json', { name: '@minecraft/server', types: './index.d.ts' });
  await put(authored.root, 'node_modules/@minecraft/server/index.d.ts', `
    export declare class ContainerSlot {readonly isValid:boolean}
    export declare class Container {getSlot(index:number):ContainerSlot}
    export declare class EntityInventoryComponent {readonly container:Container}
    export declare class Entity {getComponent(id:'minecraft:inventory'):EntityInventoryComponent|undefined}
  `);
  await put(authored.root, 'node_modules/@bedrock-core/server-runtime/package.json', {
    name: '@bedrock-core/server-runtime', exports: { './api/native-access': './tracker.js' },
  });
  await put(authored.root, 'node_modules/@bedrock-core/server-runtime/tracker.js', 'export const nativeAccess = { inventorySlot: (...args) => args };');
  await put(staged.project, 'entry.ts', source);
  const result = await bundleScripts({ root: staged.project, dependencyRoot: authored.project, entry: 'entry.ts', outfile: 'output.js', nativeAccess: true, debug: true });
  const code = await readFile(result.files.find(file => file.endsWith('output.js')), 'utf8');

  assert.match(code, /nativeAccess\.inventorySlot\(entity, index, "Entity\.getComponent", false\)/);
  assert(result.watchFiles.some(file => file.endsWith(path.join('@minecraft/server/index.d.ts'))));
});

test('native tracing rejects an unresolved SDK before publishing an untraced bundle', async (t) => {
  const project = await projectFor(t);

  await put(project.project, 'entry.ts', source);
  await assert.rejects(bundleScripts({ root: project.project, entry: 'entry.ts', outfile: 'output.js', nativeAccess: true }), /requires resolvable @minecraft\/server declarations/);
  await assert.rejects(access(path.join(project.project, 'output.js')), { code: 'ENOENT' });
});
