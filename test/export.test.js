import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import fs, { mkdir, readFile, writeFile, readdir, symlink, rm, stat, utimes, rename, link } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { projectFor } from '../test-support/project.js';
import { manifestFor } from '../test-support/manifest.js';
import { runBuild } from '../src/run.ts';
import { exportPacks, resolveExportPaths, withExportPaths } from '../src/export.ts';
import { validateConfig } from '../src/config.ts';

test('export variables resolve absolute and relative paths without recursively expanding values', () => {
  const project = path.resolve('test-project');
  const packs = { resources: './packs/RP' };
  const output = path.resolve(project, '../pack output');
  const environment = {
    'PACK_OUTPUT': output, 'PACK_NAME': 'My Addon', 'RELATIVE_OUTPUT': './build',
    'ProgramFiles(x86)': output, 'LITERAL_OUTPUT': './build/$UNCHANGED/%UNCHANGED%',
  };

  for (const directory of ['%PACK_OUTPUT%/%PACK_NAME%', '${PACK_OUTPUT}/${PACK_NAME}', '$PACK_OUTPUT/$PACK_NAME']) {
    assert.deepEqual(resolveExportPaths(project, packs, { resources: directory }, environment), {
      resources: path.join(output, 'My Addon'),
    });
  }

  assert.equal(resolveExportPaths(project, packs, { resources: '$RELATIVE_OUTPUT/RP' }, environment).resources, path.join(project, 'build/RP'));
  assert.equal(resolveExportPaths(project, packs, { resources: '%ProgramFiles(x86)%/RP' }, environment).resources, path.join(output, 'RP'));
  assert.equal(resolveExportPaths(project, packs, { resources: '${LITERAL_OUTPUT}/RP' }, environment).resources, path.join(project, 'build/$UNCHANGED/%UNCHANGED%/RP'));
  const differentlyCased = () => resolveExportPaths(project, packs, { resources: '%pack_output%/RP' }, environment);

  if (process.platform === 'win32') {
    assert.equal(differentlyCased().resources, path.join(output, 'RP'));
  } else {
    assert.throws(differentlyCased, /unset or empty: pack_output/);
  }
});

test('unset or empty export variables and shell expressions fail during path resolution', () => {
  const project = path.resolve('test-project');
  const packs = { resources: './packs/RP' };

  for (const environment of [{}, { OUTPUT: undefined }, { OUTPUT: '' }, { OUTPUT: '   ' }]) {
    for (const directory of ['%OUTPUT%/RP', '${OUTPUT}/RP', '$OUTPUT/RP']) {
      assert.throws(() => resolveExportPaths(project, packs, { resources: directory }, environment), /unset or empty: OUTPUT/);
    }
  }

  assert.throws(() => resolveExportPaths(project, packs, { resources: '${OUTPUT:-dist}/RP' }, {}), /Unsupported export environment variable expression/);
});

test('expanded destinations still enforce source, project and destination separation', async (t) => {
  const project = await projectFor(t);

  for (const output of [project.project, './packs/gameplay', './.bedrock-core/output', './output', './reserved.builder-lock']) {
    assert.throws(() => resolveExportPaths(project.project, project.config.packs, {
      gameplay: '%OUTPUT%', visuals: './output/RP',
    }, { OUTPUT: output }), /dedicated pack directory|separate directories|reserved .builder- names/);
  }

  assert.throws(() => resolveExportPaths(project.project, project.config.packs, {
    gameplay: '%OUTPUT%/same', visuals: '${OUTPUT}/same',
  }, { OUTPUT: './dist' }), /separate directories/);
});

test('runner exports to environment paths and rejects unset variables before plugin execution', async (t) => {
  const project = await projectFor(t);
  const variable = 'BEDROCK_CORE_TEST_EXPORT_ROOT';
  const previous = process.env[variable];

  process.env[variable] = path.join(project.root, 'development packs');
  t.after(() => {
    if (previous === undefined) {
      delete process.env[variable];
    } else {
      process.env[variable] = previous;
    }
  });
  project.config.bedrockCore.profiles.default.export = {
    gameplay: `%${variable}%/BP`, visuals: '${' + variable + '}/RP',
  };
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.equal(result.outputPaths.gameplay, path.join(process.env[variable], 'BP'));
  assert.equal(result.outputPaths.visuals, path.join(process.env[variable], 'RP'));
  assert.match(await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), /value = 1/);
  assert.equal(await readFile(path.join(result.outputPaths.visuals, 'asset.json'), 'utf8'), '{"value":1}');
  await writeFile(path.join(project.project, 'plugin.ts'), 'throw new Error("plugin loaded");');
  project.config.bedrockCore.plugins = { unsafe: { module: './plugin.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'unsafe', after: 'prepare' }];
  await writeFile(project.configPath, JSON.stringify(project.config));
  delete process.env[variable];
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), new RegExp(`unset or empty: ${variable}`));
});

test('standalone exports expand caller-supplied environment paths before publishing', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');
  const output = path.join(project.root, 'standalone output');
  const result = await exportPacks({
    packs: { visuals: source }, paths: { visuals: '%OUTPUT%/${PACK_NAME}' },
    environment: { OUTPUT: output, PACK_NAME: 'RP' },
  });

  assert.deepEqual(result, [{ id: 'visuals', path: path.join(output, 'RP') }]);
  assert.equal(await readFile(path.join(output, 'RP/asset.json'), 'utf8'), '{"value":1}');
});

test('each pack exports directly to its own relative or absolute path and leaves siblings intact', async (t) => {
  const project = await projectFor(t);
  const minecraft = path.join(project.root, 'minecraft');
  const paths = {
    gameplay: path.join(minecraft, 'development_behavior_packs/my-addon'),
    visuals: './assets-output',
  };

  project.config.bedrockCore.profiles.default.export = paths;
  await mkdir(path.join(minecraft, 'development_behavior_packs/unrelated'), { recursive: true });
  await writeFile(path.join(minecraft, 'development_behavior_packs/unrelated/keep'), 'keep');
  await writeFile(project.configPath, JSON.stringify(project.config));
  const result = await runBuild({ configPath: project.configPath, logger: {} });

  assert.deepEqual(result.outputPaths, {
    gameplay: paths.gameplay,
    visuals: path.join(project.project, 'assets-output'),
  });
  assert.deepEqual(result.packs.map(pack => pack.path), Object.values(result.outputPaths));
  assert.match(await readFile(path.join(paths.gameplay, 'scripts/main.js'), 'utf8'), /value = 1/);
  assert.equal(await readFile(path.join(result.outputPaths.visuals, 'asset.json'), 'utf8'), '{"value":1}');
  assert.deepEqual((await readdir(paths.gameplay)).sort(), ['manifest.json', 'scripts']);
  await writeFile(path.join(paths.gameplay, 'stale.json'), '{}');
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'export const value = 2;');
  await runBuild({ configPath: project.configPath, logger: {} });
  await assert.rejects(readFile(path.join(paths.gameplay, 'stale.json')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(minecraft, 'development_behavior_packs/unrelated/keep'), 'utf8'), 'keep');
  assert.match(await readFile(path.join(paths.gameplay, 'scripts/main.js'), 'utf8'), /value = 2/);
});

test('cancellation after one replacement rolls every pack back and removes owned temporary folders', async (t) => {
  const project = await projectFor(t);
  const result = await runBuild({ configPath: project.configPath, logger: {} });
  const packs = Object.fromEntries(result.packs.map(pack => [pack.id, pack.path]));
  const paths = {
    gameplay: path.join(project.root, 'external/BP'),
    visuals: path.join(project.root, 'other/RP'),
  };

  await exportPacks({ packs, paths });

  for (const directory of Object.values(paths)) {
    await writeFile(path.join(directory, 'previous'), 'previous');
  }

  const cancellation = new AbortController();
  const check = cancellation.signal.throwIfAborted.bind(cancellation.signal);

  t.mock.method(cancellation.signal, 'throwIfAborted', () => {
    // The first replacement removes its stale file; cancel while the next destination is pending.
    if (!existsSync(path.join(paths.gameplay, 'previous'))) {
      cancellation.abort(new Error('cancelled between exports'));
    }

    check();
  });

  await assert.rejects(exportPacks({ packs, paths, signal: cancellation.signal }), /cancelled between exports/);

  for (const directory of Object.values(paths)) {
    assert.equal(await readFile(path.join(directory, 'previous'), 'utf8'), 'previous');
    assert.equal((await readdir(path.dirname(directory))).some(name => name.includes('.builder-')), false);
  }
});

test('destination conflicts prevent replacing any pack and locks preserve existing outputs', async (t) => {
  const project = await projectFor(t);
  const options = { configPath: project.configPath, logger: {} };
  const result = await runBuild(options);
  const previous = await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8');

  await writeFile(path.join(result.outputPaths.visuals, 'manifest.json'), '{"unrelated":true}');
  await writeFile(path.join(project.project, 'packs/gameplay/scripts/main.ts'), 'export const value = 3;');
  await assert.rejects(runBuild(options), /does not identify a pack/);
  assert.equal(await readFile(path.join(result.outputPaths.gameplay, 'scripts/main.js'), 'utf8'), previous);
  await withExportPaths({ visuals: result.outputPaths.visuals }, async () => {
    await assert.rejects(runBuild(options), { code: 'EEXIST' });
    assert.equal((await readdir(path.dirname(result.outputPaths.gameplay))).some(name => name.includes('.builder-')), false);
  });

  await withExportPaths(result.outputPaths, async () => {});
  await assert.rejects(runBuild({ ...options, signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});

test('system-pack exports keep locks and all publication artifacts outside scanned pack folders', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');
  const parent = path.join(project.root, 'bds/system_resource_packs');
  const paths = { visuals: path.join(parent, 'example') };
  const cancellation = new AbortController();

  t.mock.method(cancellation.signal, 'throwIfAborted', () => {
    assert.equal(readdirSync(parent).some(name => name.includes('.builder-')), false);
  });

  await withExportPaths(paths, async (publish) => {
    assert.deepEqual(await readdir(parent), []);
    await assert.rejects(withExportPaths(paths, async () => {}), /Export destination is locked/);
    await publish({ visuals: source }, cancellation.signal);
    assert.deepEqual(await readdir(parent), ['example']);
    await writeFile(path.join(source, 'asset.json'), '{"value":2}');
    await publish({ visuals: source }, cancellation.signal);
    assert.deepEqual(await readdir(parent), ['example']);
  });

  assert.equal(await readFile(path.join(paths.visuals, 'asset.json'), 'utf8'), '{"value":2}');
});

test('publication preserves root and unchanged-file identities and handles file/directory replacements', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');
  const destination = path.join(project.root, 'published');
  const options = { packs: { visuals: source }, paths: { visuals: destination } };

  await writeFile(path.join(source, 'becomes-directory'), 'old file');
  await mkdir(path.join(source, 'becomes-file'));
  await writeFile(path.join(source, 'becomes-file/old'), 'old nested file');
  await exportPacks(options);
  const asset = path.join(destination, 'asset.json');

  await utimes(asset, 1000, 1000);
  const rootBefore = await stat(destination);
  const fileBefore = await stat(asset);

  await rm(path.join(source, 'becomes-directory'));
  await mkdir(path.join(source, 'becomes-directory'));
  await writeFile(path.join(source, 'becomes-directory/new'), 'new nested file');
  await rm(path.join(source, 'becomes-file'), { recursive: true });
  await writeFile(path.join(source, 'becomes-file'), 'new file');
  await writeFile(path.join(destination, 'stale'), 'stale file');
  await exportPacks(options);

  assert.equal((await stat(destination)).ino, rootBefore.ino);
  assert.equal((await stat(asset)).ino, fileBefore.ino);
  assert.equal((await stat(asset)).mtimeMs, fileBefore.mtimeMs);
  assert.equal(await readFile(path.join(destination, 'becomes-directory/new'), 'utf8'), 'new nested file');
  assert.equal(await readFile(path.join(destination, 'becomes-file'), 'utf8'), 'new file');
  await assert.rejects(stat(path.join(destination, 'stale')), { code: 'ENOENT' });
});

test('unchanged packs skip snapshots and same-size edits still publish', async (t) => {
  const project = await projectFor(t);
  const packs = { visuals: path.join(project.project, 'packs/visuals'), gameplay: path.join(project.project, 'packs/gameplay') };
  const paths = { gameplay: path.join(project.root, 'BP'), visuals: path.join(project.root, 'RP') };
  const asset = path.join(paths.visuals, 'asset.json');
  const timestamp = new Date('2025-01-01T00:00:00Z');
  const expected = [{ id: 'visuals', path: paths.visuals }, { id: 'gameplay', path: paths.gameplay }];

  project.behavior.modules[0].entry = 'scripts/main.js';
  await writeFile(path.join(packs.gameplay, 'manifest.json'), JSON.stringify(project.behavior));
  await writeFile(path.join(packs.gameplay, 'scripts/main.js'), 'export const value = 1;');
  await exportPacks({ packs, paths });
  await utimes(asset, timestamp, timestamp);
  const before = await stat(asset);
  const root = await stat(paths.visuals);
  const copy = t.mock.method(fs, 'cp');

  syncBuiltinESMExports();
  t.after(() => {
    copy.mock.restore();
    syncBuiltinESMExports();
  });

  assert.deepEqual(await exportPacks({ packs, paths }), expected);
  assert.equal(copy.mock.callCount(), 0);
  assert.equal((await stat(asset)).ino, before.ino);
  assert.equal((await stat(asset)).mtimeMs, before.mtimeMs);

  await writeFile(asset, '{"value":2}');
  await utimes(asset, timestamp, timestamp);
  const changed = await stat(asset);

  assert.equal(changed.size, before.size);
  assert.equal(changed.mtimeMs, before.mtimeMs);
  assert.deepEqual(await exportPacks({ packs, paths }), expected);
  assert.equal(copy.mock.callCount(), 2);
  assert.equal(await readFile(asset, 'utf8'), '{"value":1}');
  assert.equal((await stat(paths.visuals)).ino, root.ino);
});

test('binary exports compare all bytes across batches and preserve unchanged files despite matching timestamps', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');
  const destination = path.join(project.root, 'published');
  const options = { packs: { visuals: source }, paths: { visuals: destination } };
  const contents = Array.from({ length: 12 }, (_, index) => Buffer.alloc(index === 0 ? 0 : 3 * 64 * 1024 + 19, index));

  for (const [index, content] of contents.entries()) {
    await writeFile(path.join(source, `${index}.bin`), content);
  }

  await exportPacks(options);

  for (let index = 0; index < contents.length; index++) {
    await utimes(path.join(destination, `${index}.bin`), 1000, 1000);
  }

  const unchanged = await stat(path.join(destination, '11.bin'));
  const corrupt = Buffer.from(contents[3]);

  corrupt[corrupt.length - 1] ^= 0xff;
  await writeFile(path.join(destination, '3.bin'), corrupt);
  await utimes(path.join(destination, '3.bin'), 1000, 1000);
  await utimes(path.join(source, '3.bin'), 1000, 1000);
  contents[1][64 * 1024] ^= 0xff;
  contents[2] = Buffer.concat([contents[2], Buffer.from('growth')]);
  contents[4] = contents[4].subarray(0, 64 * 1024 - 1);
  contents[5] = Buffer.alloc(0);

  for (const index of [1, 2, 4, 5]) {
    await writeFile(path.join(source, `${index}.bin`), contents[index]);
    await utimes(path.join(source, `${index}.bin`), 1000, 1000);
  }

  await exportPacks(options);

  for (const [index, content] of contents.entries()) {
    assert.deepEqual(await readFile(path.join(destination, `${index}.bin`)), content);
  }

  const after = await stat(path.join(destination, '11.bin'));

  assert.equal(after.ino, unchanged.ino);
  assert.equal(after.mtimeMs, unchanged.mtimeMs);
  assert.equal((await stat(path.join(destination, '0.bin'))).mtimeMs, 1_000_000);
});

test('canceling a partially created export removes its new root and preserves siblings', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');
  const destination = path.join(project.root, 'published');
  const sibling = path.join(project.root, 'keep');
  const cancellation = new AbortController();

  await writeFile(sibling, 'unrelated');
  t.mock.method(cancellation.signal, 'throwIfAborted', () => {
    if (existsSync(path.join(destination, 'asset.json'))) {
      throw new Error('cancelled after first file');
    }
  });

  await assert.rejects(exportPacks({ packs: { visuals: source }, paths: { visuals: destination }, signal: cancellation.signal }), /cancelled after first file/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  assert.equal(await readFile(sibling, 'utf8'), 'unrelated');
});

test('symlinks inside existing exports are refused before any output changes', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');
  const destination = path.join(project.root, 'published');
  const external = path.join(project.root, 'external');
  const options = { packs: { visuals: source }, paths: { visuals: destination } };

  await exportPacks(options);
  await mkdir(external);
  await writeFile(path.join(external, 'keep'), 'unrelated');
  await symlink(external, path.join(destination, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(source, 'asset.json'), '{"value":2}');
  await assert.rejects(exportPacks(options), /contains a symlink/);
  assert.equal(await readFile(path.join(destination, 'asset.json'), 'utf8'), '{"value":1}');
  assert.equal(await readFile(path.join(external, 'keep'), 'utf8'), 'unrelated');
});

async function holdWindowsPath(t, file, share) {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ExportHandle {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
}
'@
$handle = [ExportHandle]::CreateFile($env:BC_EXPORT_TEST_PATH, [uint32]2147483648, ${share}, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
if ($handle.IsInvalid) { throw "CreateFile failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try { [Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null } finally { $handle.Dispose() }
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, env: { ...process.env, BC_EXPORT_TEST_PATH: file }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let diagnostics = '';
  let released = false;

  const release = async () => {
    if (!released) {
      released = true;
      child.stdin.end('\n');
    }

    await closed;
  };

  child.stderr.on('data', (data) => {
    diagnostics += data;
  });
  t.after(release);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => {
      if (data.toString().includes('READY')) {
        resolve();
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error(`Handle helper exited (${code}): ${diagnostics}`));
    });
  });

  return release;
}

test('Windows exports update packs while a native directory handle denies root renames', { skip: process.platform !== 'win32', timeout: 15000 }, async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');
  const destination = path.join(project.root, 'system_resource_packs/example');
  const options = { packs: { visuals: source }, paths: { visuals: destination } };

  await exportPacks(options);
  const release = await holdWindowsPath(t, destination, 3);

  try {
    await assert.rejects(rename(destination, `${destination}-rename-probe`), error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
    await writeFile(path.join(source, 'asset.json'), '{"value":2}');
    await exportPacks(options);
    assert.equal(await readFile(path.join(destination, 'asset.json'), 'utf8'), '{"value":2}');
  } finally {
    await release();
  }
});

test('a Windows file sharing conflict restores changes already published to other packs', { skip: process.platform !== 'win32', timeout: 15000 }, async (t) => {
  const project = await projectFor(t);
  const packs = { first: path.join(project.project, 'packs/visuals'), second: path.join(project.project, 'packs/gameplay') };
  const paths = { first: path.join(project.root, 'RP'), second: path.join(project.root, 'BP') };

  project.behavior.modules[0].entry = 'scripts/main.js';
  await writeFile(path.join(packs.second, 'manifest.json'), JSON.stringify(project.behavior));
  await writeFile(path.join(packs.second, 'scripts/main.js'), 'previous script');
  await exportPacks({ packs, paths });
  const locked = path.join(paths.second, 'scripts/main.js');
  const previous = await readFile(locked, 'utf8');

  const release = await holdWindowsPath(t, locked, 1);

  try {
    await writeFile(path.join(packs.first, 'asset.json'), '{"value":2}');
    await writeFile(path.join(packs.second, 'scripts/main.js'), 'changed script');
    await assert.rejects(exportPacks({ packs, paths }), error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
    assert.equal(await readFile(path.join(paths.first, 'asset.json'), 'utf8'), '{"value":1}');
    assert.equal(await readFile(locked, 'utf8'), previous);
  } finally {
    await release();
  }
});

test('changed hard-linked destination files cannot overwrite an external target', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');
  const destination = path.join(project.root, 'published');
  const options = { packs: { visuals: source }, paths: { visuals: destination } };

  await exportPacks(options);
  const external = path.join(project.root, 'external');

  await writeFile(external, '{"value":1}');
  await rm(path.join(destination, 'asset.json'));
  await link(external, path.join(destination, 'asset.json'));
  await writeFile(path.join(source, 'asset.json'), '{"value":2}');
  await assert.rejects(exportPacks(options), /independent regular file/);
  assert.equal(await readFile(external, 'utf8'), '{"value":1}');
});

test('failed rollback retains recovery snapshots outside the destination tree', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');
  const destination = path.join(project.root, 'published');
  const options = { packs: { visuals: source }, paths: { visuals: destination } };

  await exportPacks(options);
  await writeFile(path.join(source, 'asset.json'), '{"value":2}');
  const cancellation = new AbortController();

  t.mock.method(cancellation.signal, 'throwIfAborted', () => {
    if (!cancellation.signal.aborted && readFileSyncValue() === '{"value":2}') {
      renameSync(destination, path.join(project.root, 'moved'));
      writeFileSync(destination, 'conflicting file');
      cancellation.abort(new Error('cancelled during export'));
    }

    if (cancellation.signal.aborted) {
      throw cancellation.signal.reason;
    }
  });

  function readFileSyncValue() {
    return existsSync(path.join(destination, 'asset.json')) ? readFileSync(path.join(destination, 'asset.json'), 'utf8') : undefined;
  }

  let failure;

  try {
    await exportPacks({ ...options, signal: cancellation.signal });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof AggregateError);
  const workspace = failure.message.split('recovery files retained at ')[1];

  assert.ok(workspace);
  assert.match(path.basename(workspace), /^bedrock-core-export-/);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  assert.equal(await readFile(path.join(workspace, '0-previous/asset.json'), 'utf8'), '{"value":1}');
  assert.equal(await readFile(path.join(workspace, '0-next/asset.json'), 'utf8'), '{"value":2}');
});

test('explicit destinations export non-behavior/resource pack types without inferred routing', async (t) => {
  const project = await projectFor(t);
  const source = path.join(project.project, 'packs/visuals');

  await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifestFor('world_template')));
  const destination = path.join(project.root, 'world-template');

  await exportPacks({ packs: { template: source }, paths: { template: destination } });
  assert.equal(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')).modules[0].type, 'world_template');
});

test('unknown or missing pack destinations fail before executing plugins', async (t) => {
  const project = await projectFor(t);

  await writeFile(path.join(project.project, 'plugin.ts'), 'throw new Error("plugin loaded");');
  project.config.bedrockCore.plugins = { unsafe: { module: './plugin.ts' } };
  project.config.bedrockCore.profiles.default.steps = [{ plugin: 'unsafe', after: 'prepare' }];
  project.config.bedrockCore.profiles.default.export = { gameplay: './dist/gameplay' };
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /missing for pack: visuals/);
  project.config.bedrockCore.profiles.default.export.visuals = './dist/visuals';
  project.config.bedrockCore.profiles.default.export.unknown = './dist/unknown';
  await writeFile(project.configPath, JSON.stringify(project.config));
  await assert.rejects(runBuild({ configPath: project.configPath, logger: {} }), /not configured: unknown/);
});

test('destinations cannot overlap each other, pack sources or the project root', async (t) => {
  const project = await projectFor(t);

  for (const paths of [
    { gameplay: './same', visuals: './same' },
    { gameplay: './output', visuals: './output/nested' },
    { gameplay: './packs/gameplay', visuals: './RP' },
    { gameplay: './packs', visuals: './RP' },
    { gameplay: '.', visuals: '../RP' },
    { gameplay: '../', visuals: './RP' },
    { gameplay: './.bedrock-core/output', visuals: './RP' },
  ]) {
    assert.throws(() => resolveExportPaths(project.project, project.config.packs, paths), /dedicated pack directory|separate directories/);
  }

  const source = path.join(project.project, 'packs/visuals');

  await assert.rejects(exportPacks({ packs: { visuals: source }, paths: { visuals: path.join(source, 'nested/output') } }), /separate directories/);
  await assert.rejects(readdir(path.join(source, 'nested')), { code: 'ENOENT' });
  assert.throws(() => resolveExportPaths(project.project, project.config.packs, {
    gameplay: './output', visuals: './output.builder-lock',
  }), /reserved .builder- names/);
});

test('Windows export paths exclude existing outputs regardless of directory letter case', { skip: process.platform !== 'win32' }, async (t) => {
  const project = await projectFor(t);

  project.config.bedrockCore.profiles.default.export.gameplay = './DIST/GAMEPLAY';
  await writeFile(project.configPath, JSON.stringify(project.config));
  const options = { configPath: project.configPath, logger: {} };

  await runBuild(options);
  const result = await runBuild(options);

  assert.equal(result.stages.find(stage => stage.stage === 'bundler').status, 'cached');
  assert.match(await readFile(path.join(project.project, 'dist/gameplay/scripts/main.js'), 'utf8'), /value = 1/);
});

test('symlink destination parents are refused without changing their targets', async (t) => {
  const project = await projectFor(t);
  const target = path.join(project.root, 'target');
  const link = path.join(project.project, 'linked');

  await mkdir(target);
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(link, { force: true, recursive: true }));
  await assert.rejects(exportPacks({
    packs: { visuals: path.join(project.project, 'packs/visuals') },
    paths: { visuals: path.join(link, 'output') },
  }), /symlink ancestors/);
  assert.deepEqual(await readdir(target), []);
});

test('a nonempty destination without a pack manifest is preserved', async (t) => {
  const project = await projectFor(t);
  const destination = path.join(project.root, 'unrelated');

  await mkdir(destination);
  await writeFile(path.join(destination, 'keep'), 'keep');
  await assert.rejects(exportPacks({
    packs: { visuals: path.join(project.project, 'packs/visuals') },
    paths: { visuals: destination },
  }), /does not identify a pack/);
  assert.equal(await readFile(path.join(destination, 'keep'), 'utf8'), 'keep');
});

test('configuration schema accepts pack path maps and validates destination values', async (t) => {
  const project = await projectFor(t);

  validateConfig(project.config);

  for (const value of [true, 1, {}, '', '  ']) {
    const config = structuredClone(project.config);

    config.bedrockCore.profiles.default.export.gameplay = value;
    assert.throws(() => validateConfig(config), /Invalid project configuration/);
  }
});
