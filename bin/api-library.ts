import path from 'node:path';
import { emitApiLibrary } from '@bedrock-core/builder-bundler';

const [entry, output, root = process.cwd()] = process.argv.slice(2);

if (!entry || !output || entry === '--help' || entry === '-h') {
  console.log('bc-builder api-library <entry.ts> <output.generated.ts> [package-root]');
} else {
  const result = await emitApiLibrary({ root: path.resolve(root), entry, output });

  console.log(`Generated ${result.output}`);
}
