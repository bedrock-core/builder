import { runBuild } from '../src/run.ts';

const cancellation = new AbortController();

process.once('SIGINT', () => cancellation.abort(new Error('Build cancelled')));

try {
  const result = await runBuild({
    configPath: process.argv[2] ?? 'config.json',
    profile: process.argv[3] ?? 'default',
    signal: cancellation.signal,
  });

  console.log(`@bedrock-core/builder: exported ${result.outputPath}`);

  for (const pack of result.deployments) {
    console.log(`@bedrock-core/builder: deployed ${pack.id} to ${pack.path}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
