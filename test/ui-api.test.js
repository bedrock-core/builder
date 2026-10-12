import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as ui from '@bedrock-core/builder-ui';
import * as plugin from '@bedrock-core/builder-ui/plugin';

test('UI package exposes its plugin entrypoint and keeps compilation helpers private', () => {
  assert.deepEqual(Object.keys(ui), []);
  assert.deepEqual(Object.keys(plugin).sort(), ['detect', 'run']);
  assert.throws(() => createRequire(import.meta.url).resolve('@bedrock-core/builder-ui/transform'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
});
