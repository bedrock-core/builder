import { glob, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContext } from './contract.d.ts';
import type { StageName } from './config.ts';
import { templateFiles } from './template-files.ts';
import { readScriptEntries } from './manifest.ts';
import { scriptCandidates } from './stages/bundler.ts';

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

    if (!needed) {
      needed = await hasFiles(context.projectRoot, '.bedrock-core/generated/ui/screens.generated.d.ts');
      input = needed ? 'generated UI declarations to refresh' : input;
    }

    if (!needed) {
      for (const id of Object.keys(context.packs)) {
        const pack = await context.inspectPack(id);

        if (pack.kind !== 'behavior') {
          continue;
        }

        for (const entry of await readScriptEntries(id, pack.path)) {
          let source = '';

          for (const file of scriptCandidates(path.resolve(pack.path, entry))) {
            try {
              if ((await stat(file)).isFile()) {
                source += await readFile(file, 'utf8');
              }
            } catch (error) {
              if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                throw error;
              }
            }
          }

          if (source.includes('@bedrock-core/generated/ui')) {
            needed = true;
            input = 'generated UI imports in manifest entries';
          } else if (/['"]@bedrock-core\/server(?:-runtime)?['"]/.test(source)) {
            let directory = context.projectRoot;

            while (true) {
              if (await hasFiles(directory, 'node_modules/@bedrock-core/ui/package.json')) {
                needed = true;
                input = 'addon declarations with the installed UI toolkit';
                break;
              }

              const parent = path.dirname(directory);

              if (directory === parent) {
                break;
              }

              directory = parent;
            }
          }
        }
      }
    }
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
