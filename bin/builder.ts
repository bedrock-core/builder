#!/usr/bin/env node
const commands = ['build', 'watch', 'plan', 'migrate', 'audit-paths', 'api-library'];
const command = process.argv[2];

if (!command || command === '--help' || command === '-h') {
  console.log('@bedrock-core/builder: bc-builder <build|watch|plan|migrate> [config.json] [profile]');
  console.log('@bedrock-core/builder: bc-builder audit-paths <pack-or-add-on-directory> [--help]');
  console.log('@bedrock-core/builder: bc-builder api-library <entry.ts> <output.generated.ts> [package-root]');
} else if (!commands.includes(command)) {
  console.error(`Unknown builder command: ${command}`);
  process.exitCode = 1;
} else {
  process.argv.splice(2, 1);
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

  await import(`./${command}.${extension}`);
}
