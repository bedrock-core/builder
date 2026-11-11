import { put } from './project.js';

/** Install a fixture Runtime package without replacing its test-specific API model. */
export async function installFakeRuntime(root, { source = 'export const core = { register() {} };', entry = 'index.js', client } = {}) {
  const directory = 'node_modules/@bedrock-core/server-runtime';
  const exports = { '.': `./${entry}`, './api': `./${entry}` };

  if (client !== undefined) {
    exports['./api/client'] = './client.js';
  }

  await Promise.all([
    put(root, `${directory}/package.json`, JSON.stringify({ name: '@bedrock-core/server-runtime', version: '1.0.0', type: 'module', exports })),
    put(root, `${directory}/${entry}`, source),
    ...client === undefined ? [] : [put(root, `${directory}/client.js`, client)],
  ]);
}
