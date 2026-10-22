#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Command, Option } from 'commander';
import { createProject } from './generator.ts';
import type { PackageManager } from './prompts.ts';
import type { ScaffoldOptions } from './generator.ts';
import chalk from 'chalk';

// Resolve the package manifest from both src/index.ts and dist/index.js.
const manifest: unknown = createRequire(import.meta.url)('../package.json');
const version
  = typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string'
    ? manifest.version
    : '0.0.0';

const program = new Command();

interface CliOptions extends ScaffoldOptions {
  author?: string;
  description?: string;
  packageManager?: PackageManager;
}

program
  .name('@bedrock-core/cli')
  .description('Scaffold Minecraft Bedrock addon projects with @bedrock-core/builder')
  .version(version)
  .argument('[project-name]', 'Name of the project directory')
  .option('-a, --author <name>', 'Author name (skips the prompt; enables non-interactive use)')
  .option('-d, --description <text>', 'Project description (skips the prompt; enables non-interactive use)')
  .option('--display-name <name>', 'Human-readable project name; defaults to the npm project name')
  .option('--creator-id <id>', 'Stable Minecraft creator identifier')
  .option('--pack-id <id>', 'Stable runtime addon identifier')
  .addOption(new Option('--preset <preset>', 'Choose a full framework, behavior-only script, or resource-only project').choices(['full', 'script', 'resource']).default('full'))
  .addOption(new Option('-p, --package-manager <manager>', 'Install with yarn, npm, pnpm, or choose none')
    .choices(['yarn', 'npm', 'pnpm', 'none']))
  .action(async (projectName: string | undefined, options: CliOptions) => {
    try {
      await createProject(projectName, options.author, options.description, options.packageManager, options);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
  });

program.parse();
