import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const local = [], central = []; let offset = 0;
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
async function files(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`, name = prefix + entry.name;
    if (entry.isDirectory()) { await files(path, name + '/'); continue; }
    const bytes = await readFile(path), zipped = deflateRawSync(bytes), encoded = Buffer.from(name), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(zipped.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(encoded.length, 26);
    local.push(header, encoded, zipped);
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20, 4); item.writeUInt16LE(20, 6); item.writeUInt16LE(0x800, 8); item.writeUInt16LE(8, 10); item.writeUInt16LE(33, 14);
    item.writeUInt32LE(crc, 16); item.writeUInt32LE(zipped.length, 20); item.writeUInt32LE(bytes.length, 24); item.writeUInt16LE(encoded.length, 28); item.writeUInt32LE(offset, 42);
    central.push(item, encoded); offset += header.length + encoded.length + zipped.length;
  }
}
await files('dist');
const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const filename = `KemonoPawchiveArchiveRipper-${manifest.version}.zip`;
await writeFile(filename, Buffer.concat([...local, directory, end]));
console.log('Packaged: ' + resolve(filename));
