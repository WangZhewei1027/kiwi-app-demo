import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'public');
// Only these files are public. Environment files, server code and repository
// documentation never enter the static output directory.
const files = [
  'index.html',
  'explorable-app/index.html',
  'explorable-app/kiwi-app-sdk/kiwi-app-sdk.js',
  'explorable-app/premade/catalog.json',
];

await rm(output, { recursive: true, force: true });
for (const file of files) {
  const target = join(output, file);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, file), target);
}
console.log(`Built ${files.length} public files.`);
