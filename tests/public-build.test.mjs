import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('public build includes only browser assets and never embeds server configuration', async () => {
  const sentinel = 'build-test-secret-never-publish';
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: root,
    env: { ...process.env, AI_API_KEY: sentinel },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = join(root, 'public');
  const names = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), name + '/');
      else names.push(name);
    }
  }
  await visit(output);
  assert.deepEqual(names.sort(), [
    'explorable-app/index.html',
    'explorable-app/kiwi-app-sdk/kiwi-app-sdk.js',
    'explorable-app/premade/catalog.json',
    'index.html',
  ]);
  for (const name of names) {
    const content = await readFile(join(output, name), 'utf8');
    assert.ok(!content.includes(sentinel));
    if (name.endsWith('.html')) {
      for (const [, source] of content.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
        new Script(source, { filename: name });
      }
    }
  }
  const frontend = await readFile(join(output, 'explorable-app/index.html'), 'utf8');
  assert.doesNotMatch(frontend, /AI_API_KEY|AI_BASE_URL|AI_MODEL/);
  assert.match(frontend, /const AI_CHAT_URL = "\/api\/chat"/);
});
