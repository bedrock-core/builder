import { randomUUID } from 'node:crypto';

export function manifestFor(type, entry = 'scripts/main.js') {
  return {
    format_version: 3,
    header: {
      name: 'Test pack',
      description: 'Build fixture',
      uuid: randomUUID(),
      version: '1.0.0',
      min_engine_version: '1.26.50',
    },
    modules: [{
      type,
      uuid: randomUUID(),
      version: '1.0.0',
      ...(type === 'script' ? { language: 'javascript', entry } : {}),
    }],
  };
}
