import { build } from 'vite';
import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
await build();
for (const [name, entry, format] of [['background', 'src/background/index.ts', 'es'], ['content', 'src/content/index.ts', 'iife'], ['extract-worker', 'src/services/posts/extractWorker.ts', 'es']]) {
  await build({ configFile: false, publicDir: false, build: {
    outDir: 'dist', emptyOutDir: false, target: 'chrome120',
    lib: { entry: resolve(entry), name: 'KemonoArchive', formats: [format], fileName: () => `${name}.js` },
    rollupOptions: { output: { inlineDynamicImports: true } },
  } });
}
await copyFile('src/manifest.json', 'dist/manifest.json');
await copyFile('node_modules/@zip.js/zip.js/LICENSE', 'dist/zip.js-LICENSE.txt');
await copyFile('node_modules/libarchive-wasm/dist/libarchive.wasm', 'dist/libarchive.wasm');
await cp('licenses', 'dist/licenses', { recursive: true });
await mkdir('dist/icons', { recursive: true });
// Code-native geometric archive mark; no external artwork or runtime assets.
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const label = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([label, data]))); return Buffer.concat([size, label, data, crc]); }
for (const size of [16, 48, 128]) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const mark = (u > .22 && u < .36 && v > .2 && v < .8) || (u > .36 && u < .76 && Math.abs(Math.abs(v - .5) - (u - .36) * .8) < .065);
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    rows.set(mark ? [94, 234, 174, 255] : [18, 28, 32, 255], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(`dist/icons/${size}.png`, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}
console.log('Unpacked extension: ' + resolve('dist'));
