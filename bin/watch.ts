import { watchBuild } from '../src/watch.ts';

const cancellation = new AbortController();

process.once('SIGINT', () => cancellation.abort());
process.once('SIGTERM', () => cancellation.abort());

try {
  await watchBuild({
    configPath: process.argv[2] ?? 'config.json',
    profile: process.argv[3] ?? 'default',
    signal: cancellation.signal,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
