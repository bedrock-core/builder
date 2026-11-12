import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const defaultRegistryDirectory = fileURLToPath(new URL('../.bedrock-core/local-registry/', import.meta.url));
const controlPath = '/-/bedrock-core/local-registry';
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

/** Restrict local publication and credentials to an explicit IPv4 loopback origin. */
export function registryOrigin(value) {
  const url = new URL(value);

  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
    && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password,
  'Local registry must be http://127.0.0.1:<port>');

  return url.origin;
}

export async function registryStatus(directory = defaultRegistryDirectory) {
  let state;

  try {
    state = await readJson(path.join(directory, 'state.json'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }

  const endpoint = registryOrigin(state.endpoint);
  let response;

  try {
    response = await fetch(endpoint + controlPath, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  } catch {
    return undefined;
  }

  assert.equal(response.status, 200, 'Registry port is occupied by another service');
  const live = await response.json();

  assert.equal(live.id, state.id, 'Registry port belongs to another instance');
  assert.equal(live.pid, state.pid, 'Registry process identity changed');

  return { ...state, directory: path.resolve(directory) };
}

export async function requireRegistry(directory = defaultRegistryDirectory) {
  const state = await registryStatus(directory);

  assert.ok(state, 'Start the local registry with yarn registry start');

  return state;
}

export async function startRegistry({ directory = defaultRegistryDirectory, port = 4873, offline = false } = {}) {
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid registry port');
  directory = path.resolve(directory);
  await mkdir(directory, { recursive: true });
  const lockFile = path.join(directory, 'start.lock');
  let lock;

  try {
    lock = await open(lockFile, 'wx');
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }

    const owner = await readJson(lockFile);

    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }

      await rm(lockFile);

      return startRegistry({ directory, port, offline });
    }

    throw new Error('Local registry startup is already in progress', { cause: error });
  }

  try {
    return await startRegistryProcess({ directory, port, offline });
  } finally {
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

async function startRegistryProcess({ directory, port, offline }) {
  const running = await registryStatus(directory);

  if (running) {
    assert.ok(port === 0 || new URL(running.endpoint).port === String(port), 'Registry is already running on another port');

    return running;
  }

  let credentials;

  try {
    credentials = await readJson(path.join(directory, 'credentials.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    credentials = { name: 'bedrock-core-local', password: randomBytes(24).toString('hex') };
    await saveJson(path.join(directory, 'credentials.json'), credentials);
  }

  const id = randomUUID();
  const instance = { id, port, directory, offline, controlToken: randomBytes(32).toString('hex') };
  const instanceFile = path.join(directory, `instance-${id}.json`);
  const logFile = path.join(directory, 'registry.log');

  await saveJson(instanceFile, instance);
  const log = await open(logFile, 'a');
  const child = fork(fileURLToPath(import.meta.url), ['serve', instanceFile], {
    detached: true,
    windowsHide: true,
    execArgv: [],
    stdio: ['ignore', log.fd, log.fd, 'ipc'],
    env: { ...process.env, VERDACCIO_PUBLIC_URL: '' },
  });

  try {
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Registry startup timed out; see ${logFile}`)), 30_000);

      child.once('message', (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Registry exited (${code}); see ${logFile}`));
      });
    });

    registryOrigin(ready.endpoint);
    const state = { ...instance, ...ready, logFile };

    await saveJson(path.join(directory, 'state.json'), state);
    const signup = await fetch(state.endpoint + '/-/user/org.couchdb.user:' + credentials.name, {
      method: 'PUT',
      headers: { 'content-type': 'application/json',
        'authorization': 'Basic ' + Buffer.from(credentials.name + ':' + credentials.password).toString('base64') },
      body: JSON.stringify({ ...credentials, email: 'local@example.invalid', type: 'user', roles: [] }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    const account = await signup.json();

    assert.ok(signup.ok && typeof account.token === 'string', `Local registry authentication failed (${signup.status})`);
    await saveJson(path.join(directory, 'auth.json'), { token: account.token });

    return { ...state, directory };
  } catch (error) {
    child.kill();

    throw error;
  } finally {
    if (child.connected) {
      child.disconnect();
    }

    child.unref();
    await log.close();
    await rm(instanceFile, { force: true });
  }
}

export async function stopRegistry(directory = defaultRegistryDirectory) {
  const state = await registryStatus(directory);

  if (!state) {
    return false;
  }

  const response = await fetch(state.endpoint + controlPath + '/stop', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + state.controlToken },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });

  assert.equal(response.status, 200, 'Registry refused shutdown');

  for (let attempt = 0; attempt < 50; attempt++) {
    if (!await registryStatus(directory)) {
      await rm(path.join(directory, 'state.json'), { force: true });

      return true;
    }

    await delay(100);
  }

  throw new Error('Registry did not stop');
}

async function serve(instanceFile) {
  const { runServer } = await import('verdaccio');
  const instance = await readJson(instanceFile);
  const { directory, id, port, controlToken, offline } = instance;
  const server = await runServer({
    self_path: path.join(directory, 'config.yaml'),
    storage: path.join(directory, 'storage'),
    auth: { htpasswd: { file: path.join(directory, 'htpasswd'), max_users: 1 } },
    uplinks: offline ? {} : { npmjs: { url: 'https://registry.npmjs.org/' } },
    packages: {
      '@bedrock-core/*': { access: '$all', publish: '$authenticated', unpublish: '$authenticated', ...offline ? {} : { proxy: 'npmjs' } },
      '**': { access: '$all', ...offline ? {} : { proxy: 'npmjs' } },
    },
    web: { enable: true, title: '@bedrock-core local registry' },
    log: { type: 'stdout', format: 'pretty', level: 'warn' },
    check_updates: false,
  });
  const handlers = server.listeners('request');

  assert.equal(handlers.length, 1, 'Expected the Verdaccio HTTP request handler');
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (request.url === controlPath && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, pid: process.pid }));
    } else if (request.url === controlPath + '/stop' && request.method === 'POST') {
      if (request.headers.authorization !== 'Bearer ' + controlToken) {
        response.writeHead(403).end();

        return;
      }

      response.writeHead(200).end();
      shutdown();
    } else {
      handlers[0].call(server, request, response);
    }
  });

  function shutdown() {
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const endpoint = 'http://127.0.0.1:' + server.address().port;

  process.env.VERDACCIO_PUBLIC_URL = endpoint;
  process.send({ id, pid: process.pid, endpoint });
  process.disconnect();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'serve') {
    await serve(args[0]);
  } else {
    let directory = defaultRegistryDirectory;
    let port = 4873;

    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];

      assert.ok(value, 'Missing value for ' + flag);

      if (flag === '--state') {
        directory = path.resolve(value);
      } else if (flag === '--port') {
        port = Number(value);
      } else {
        throw new Error('Unknown registry option: ' + flag);
      }
    }

    if (command === 'start') {
      const state = await startRegistry({ directory, port });

      console.log('Local registry: ' + state.endpoint + '\nLog: ' + state.logFile);
    } else if (command === 'status') {
      const state = await registryStatus(directory);

      console.log(state ? 'Local registry: ' + state.endpoint : 'Local registry is stopped');
    } else if (command === 'stop') {
      console.log(await stopRegistry(directory) ? 'Local registry stopped' : 'Local registry is stopped');
    } else {
      throw new Error('Usage: yarn registry start|status|stop [--port 4873] [--state directory]');
    }
  }
}
