import { migrateRegolithProject, writeMigration } from '../src/migrate.ts';
import type { FilterKind, MigrationOptions } from '../src/migrate.ts';
import { stages } from '../src/plan.ts';

const help = `@bedrock-core Regolith configuration migration

Usage: yarn migrate [config.json] [options]

Preview is the default. Filters, shell commands and expressions are never executed.

  --write                    Write a complete migration; save an in-place backup
  --output path              With --write, create a new config beside the original
  --profile name             Select a profile (repeatable; default: all)
  --namespace value          Supply missing project namespace
  --target-version value     Supply missing targetVersion
  --export profile:pack=path  Set exact destinations (repeat for every pack)
  --filter id=stage          Map a verified local filter or fork to a stage or core
  --json                     Print config, diagnostics and readiness as JSON
  --help                     Show this help
`;

try {
  const args = process.argv.slice(2);
  const options: MigrationOptions = {};
  let configPath: string | undefined;
  let outputPath: string | undefined;
  let write = false;
  let json = false;

  function argument(index: number): string {
    const value = args[index + 1];

    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${args[index]}`);
    }

    return value;
  }

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];

    if (flag === '--help' || flag === '-h') {
      console.log(help);
      process.exit(0);
    }

    if (flag === '--write') {
      write = true;
    } else if (flag === '--json') {
      json = true;
    } else if (flag === '--namespace') {
      options.namespace = argument(index++);
    } else if (flag === '--target-version') {
      options.targetVersion = argument(index++);
    } else if (flag === '--output') {
      outputPath = argument(index++);
    } else if (flag === '--profile') {
      options.profiles ??= [];
      options.profiles.push(argument(index++));
    } else if (flag === '--export') {
      const value = argument(index++);
      const match = /^([^:=]+):([^:=]+)=(.+)$/.exec(value);

      if (!match) {
        throw new Error('--export expects profile:pack=path');
      }

      const [, profile, pack, directory] = match;

      options.exports = {
        ...options.exports,
        [profile]: { ...options.exports?.[profile], [pack]: directory },
      };
    } else if (flag === '--filter') {
      const value = argument(index++);
      const match = /^([^=]+)=([^=]+)$/.exec(value);

      if (!match || (match[2] !== 'core' && !stages.some(stage => stage === match[2]))) {
        throw new Error(`--filter expects id=core or id=${stages.join('|')}`);
      }

      options.filters = { ...options.filters, [match[1]]: match[2] as FilterKind };
    } else if (flag.startsWith('-') || configPath !== undefined) {
      throw new Error(`Unknown argument: ${flag}`);
    } else {
      configPath = flag;
    }
  }

  if (outputPath !== undefined && !write) {
    throw new Error('--output requires --write; omit both flags for a preview');
  }

  const result = await migrateRegolithProject(configPath, options);
  const written = write && result.ready ? await writeMigration(result, outputPath) : undefined;

  if (json) {
    console.log(JSON.stringify({ config: result.config, diagnostics: result.diagnostics, ready: result.ready, written }, null, 2));
  } else {
    for (const diagnostic of result.diagnostics) {
      console.error(`[${diagnostic.severity}] ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
    }

    if (written) {
      console.log(`@bedrock-core: wrote ${written.path}`);

      if (written.backup) {
        console.log(`@bedrock-core: backup ${written.backup}`);
      }
    } else {
      console.log(JSON.stringify(result.config, null, 2));
      console.error(result.ready
        ? '@bedrock-core: migration preview is ready; use --write to save it'
        : '@bedrock-core: migration requires manual changes; no files were written');
    }
  }

  if (!result.ready) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
