import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { planBuild } from '../src/plan.ts';
import { validateConfig } from '../src/config.ts';

try {
  const config = JSON.parse(await readFile(resolve(process.argv[2] ?? 'config.json'), 'utf8'));

  console.log(
    JSON.stringify(planBuild(validateConfig(config), process.argv[3] ?? 'default'), null, 2),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
