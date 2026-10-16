import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
const built = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
assert(/^\d+\.\d+\.\d+$/.test(metadata.version), 'Release must have a stable version');
for (const version of [lock.version, lock.packages[''].version, manifest.version, built.version]) assert.equal(version, metadata.version, 'Release versions must agree');
const filename = `KemonoPawchiveArchiveRipper-${metadata.version}.zip`;
const reader = new ZipReader(new Uint8ArrayReader(await readFile(filename)), { useWebWorkers: false });
try {
  const entries = await reader.getEntries(), names = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${directory}/${entry.name}`, `${prefix}${entry.name}/`);
      else names.push(prefix + entry.name);
    }
  }
  await walk('dist');
  assert.deepEqual(entries.map(entry => entry.filename).sort(), names.sort(), 'Package must contain exactly the build output');
  for (const name of ['manifest.json', 'background.js', 'content.js', 'extract-worker.js', 'libarchive.wasm', 'licenses/libarchive-wasm-LICENSE.txt', 'licenses/libarchive-COPYING.txt', 'offscreen/index.html', 'overlay/index.html', 'folder/index.html', 'zip.js-LICENSE.txt']) assert(names.includes(name), `Missing release file: ${name}`);
  for (const entry of entries) {
    assert(!/(?:^|\/)(?:node_modules|tests|\.git|\.env)(?:\/|$)/.test(entry.filename), 'Development/private files must stay out of the release');
    const bytes = await entry.getData(new Uint8ArrayWriter(), { checkSignature: true });
    assert.equal(Buffer.compare(Buffer.from(bytes), await readFile(`dist/${entry.filename}`)), 0, `Package differs from build: ${entry.filename}`);
  }
  console.log(`Verified ${filename}: version ${metadata.version}, ${entries.length} files, valid ZIP signatures, and exact build contents.`);
} finally { await reader.close(); }
