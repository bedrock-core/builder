import { parseArgs } from 'node:util';
import { auditPackPaths } from '../src/path-audit.ts';

const usage = `Usage: bc-builder audit-paths <pack-or-add-on-directory> [--max-length 100] [--creator NAME --pack NAME]

Report advisory path length, directory depth and cooperative asset-folder findings as JSON.
Pass a pack root or an unpacked add-on directory containing behavior_packs or resource_packs.
Use --creator and --pack together to check the exact asset-folder names.
Use --max-length to select a shorter path budget such as 80.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'help': { type: 'boolean', short: 'h' },
      'max-length': { type: 'string', default: '100' },
      'creator': { type: 'string' },
      'pack': { type: 'string' },
    },
  });

  if (values.help) {
    console.log(usage);
  } else {
    if (positionals.length !== 1) {
      throw new Error(usage);
    }

    const maxLength = Number(values['max-length']);

    if (!/^\d+$/.test(values['max-length']) || !Number.isSafeInteger(maxLength) || maxLength < 1) {
      throw new Error('--max-length must be a positive integer');
    }

    const { creator, pack } = values;

    if (creator !== undefined || pack !== undefined) {
      const slug = /^[a-z0-9_-]+$/;

      if (!creator || !pack || !slug.test(creator) || !slug.test(pack)) {
        throw new Error('--creator and --pack must be specified together as lowercase folder names using letters, digits, underscores or hyphens');
      }
    }

    const report = await auditPackPaths(positionals[0], { maxLength, folders: creator && pack ? { creator, pack } : undefined });

    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
