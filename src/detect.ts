import { glob, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext } from './contract.d.ts';
import type { StageName } from './config.ts';
import { templateFiles } from './template-files.ts';

export interface StageDetection {
  needed: boolean;
  reason: string;
}

async function hasFiles(root: string, patterns: string | string[], exclude: string[] = []): Promise<boolean> {
  for await (const file of glob(patterns, { cwd: root, exclude })) {
    if ((await stat(path.resolve(root, file))).isFile()) {
      return true;
    }
  }

  return false;
}

/** Probe current staging after before-stage hooks, without evaluating resource modules. */
export async function detectStage(context: BuildContext, stage: StageName): Promise<StageDetection> {
  context.signal?.throwIfAborted();
  const packPaths = Object.values(context.packs).map(directory => path.relative(context.stagedRoot, directory).replaceAll('\\', '/'));
  let needed = false;
  let input = '';

  if (stage === 'manifest') {
    needed = packPaths.length > 0;
    input = 'configured pack manifests';
  } else if (stage === 'generator') {
    needed = (await templateFiles(context)).length > 0;
    input = 'TypeScript templates outside pack scripts';
  } else if (stage === 'guides') {
    needed = await hasFiles(context.stagedRoot, 'guides/**/*.{md,mdx}');
    input = 'guide pages under guides/';
  } else if (stage === 'i18n') {
    // Let the compiler validate locale names and report malformed resource modules.
    needed = await hasFiles(context.stagedRoot, 'i18n/*.{ts,js,mts,mjs}', ['**/*.d.{ts,mts}']);
    input = 'locale resource modules under i18n/';
  } else if (stage === 'ui-compiler') {
    needed = await hasFiles(context.stagedRoot, packPaths.map(directory => `${directory}/scripts/**/*.screen.tsx`));
    input = 'screen modules in pack scripts';
  } else if (stage === 'bundler') {
    for (const id of Object.keys(context.packs)) {
      if ((await context.inspectPack(id)).moduleTypes.includes('script')) {
        needed = true;
        break;
      }
    }

    input = 'manifest script modules';
  }

  return { needed, reason: `${needed ? 'Found' : 'No'} ${input}` };
}
