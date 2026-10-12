#!/usr/bin/env node
const commands = ['build', 'watch', 'plan', 'migrate'];
const command = process.argv[2];

if (!command || command === '--help' || command === '-h') {
  console.log('@bedrock-core/builder: core-builder <build|watch|plan|migrate> [config.json] [profile]');
} else if (!commands.includes(command)) {
  console.error(`Unknown builder command: ${command}`);
  process.exitCode = 1;
} else {
  process.argv.splice(2, 1);
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

  await import(`./${command}.${extension}`);
}
