import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../src/run.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'builder-acceptance-'));
const source = fileURLToPath(new URL('../fixtures/acceptance', import.meta.url));

try {
  await cp(source, root, { recursive: true });
  const options = { configPath: path.join(root, 'config.json') };
  const first = await runBuild(options);

  assert.equal(first.packs.length, 3);
  assert.equal(first.packs.filter(pack => pack.kind === 'resource').length, 2);
  assert.ok(first.validation.files.some(file => file.schema?.includes('/items/')));
  const unchanged = await runBuild(options);

  assert.ok(unchanged.compilations.every(item => item.status === 'cached'));
  const entry = path.join(root, 'packs/BP/scripts/main.ts');

  await writeFile(entry, `${await readFile(entry, 'utf8')}\nexport const revision = 2;\n`);
  const scriptEdit = await runBuild(options);

  assert.ok(scriptEdit.compilations.filter(item => item.id.startsWith('generator/')).every(item => item.status === 'cached'));
  assert.equal(scriptEdit.stages.find(stage => stage.stage === 'bundler')?.status, 'executed');
  await writeFile(path.join(root, 'shared/drop.json'), '{"name":"minecraft:bread"}');
  const dataEdit = await runBuild(options);

  assert.equal(dataEdit.compilations.find(item => item.id === 'generator/packs/BP/items/token.ts')?.status, 'cached');
  assert.equal(dataEdit.compilations.find(item => item.id === 'generator/packs/BP/loot_tables/drop.ts')?.status, 'executed');
  await writeFile(path.join(root, 'shared/drop.json'), '{"name":"minecraft:apple"}');
  await runBuild(options);

  if (process.argv.includes('--native')) {
    const cli = process.env.BUILDER_BDS_RUNNER;

    if (!cli) {
      throw new Error('Native acceptance needs BUILDER_BDS_RUNNER pointing to the installed bc-bds.mjs CLI');
    }

    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', '--packs', path.join(root, 'dist'), '--packs', path.join(root, 'dist/theme'), '--tag', 'builder_acceptance', '--expect-registered', '2', '--port', '19773', '--idle', '1', '--timeout', '180', '--fresh'], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, BC_BDS_HOME: path.join(repository, '.bedrock-core/acceptance/bds') },
      });

      child.once('error', reject);
      child.once('exit', resolve);
    });

    assert.equal(status, 0, 'Native GameTest acceptance must pass');
  }

  console.log('@bedrock-core/builder: addon acceptance passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
